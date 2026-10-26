import argparse
import datetime
import errno
import json
import math
import os
from pathlib import Path
import re
import signal
import sys
import threading
import time


PROC = Path('/proc')
IO_FIELDS = ('rchar', 'wchar', 'syscr', 'syscw', 'read_bytes', 'write_bytes', 'cancelled_write_bytes')


def require_linux():
    if sys.platform != 'linux':
        raise RuntimeError('LINUX_ONLY')


def parse_stat(raw):
    opening = raw.find('(')
    closing = raw.rfind(')')
    if opening < 1 or closing <= opening:
        raise ValueError('PROC_STAT_FORMAT_INVALID')
    fields = raw[closing + 1:].split()
    if len(fields) < 20:
        raise ValueError('PROC_STAT_FIELDS_MISSING')
    return {
        'pid': int(raw[:opening].strip()),
        'comm': raw[opening + 1:closing],
        'state': fields[0],
        'ppid': int(fields[1]),
        'userTicks': int(fields[11]),
        'systemTicks': int(fields[12]),
        'numThreads': int(fields[17]),
        'starttimeTicks': int(fields[19]),
    }


def read_identity(pid):
    require_linux()
    record = parse_stat((PROC / str(pid) / 'stat').read_text(encoding='utf-8', errors='replace'))
    if record['pid'] != pid:
        raise ValueError('PROC_PID_MISMATCH')
    return {'pid': pid, 'starttimeTicks': record['starttimeTicks']}


def identity(record):
    return record['pid'], record['starttimeTicks']


def role_hint(comm):
    name = comm.lower()
    match = re.search(r'vitest[ _-]+(\d+)', name)
    if match:
        return {'kind': 'vitest_named_worker_candidate', 'workerNameIndex': int(match.group(1))}
    if 'vitest' in name:
        return {'kind': 'vitest_named_process'}
    if 'worker' in name:
        return {'kind': 'worker_named_task_unclassified'}
    if name == 'node' or name.startswith('node '):
        return {'kind': 'node_task_unclassified'}
    return {'kind': 'unclassified'}


def parse_service_units(raw):
    if not raw.strip():
        raise ValueError('PROC_CGROUP_EMPTY')
    units = set()
    instances_redacted = False
    for line in raw.splitlines():
        fields = line.split(':', 2)
        if len(fields) != 3 or not fields[0].isdecimal() or not fields[2].startswith('/'):
            raise ValueError('PROC_CGROUP_FORMAT_INVALID')
        in_service_slice = False
        for component in fields[2].split('/'):
            if component in ('system.slice', 'user.slice'):
                in_service_slice = True
            elif in_service_slice and component.endswith('.service'):
                if len(component) > 255 or not re.fullmatch(r'[A-Za-z0-9_:.@\\-]+\.service', component):
                    raise ValueError('PROC_CGROUP_SERVICE_NAME_INVALID')
                if '@' in component:
                    component = component.split('@', 1)[0] + '@.service'
                    instances_redacted = True
                units.add(component)
    return {'serviceUnits': sorted(units), 'serviceUnitsStatus': 'ok' if units else 'no_service_unit', 'serviceUnitInstancesRedacted': instances_redacted}


def error_record(component, error, pid=None, tid=None):
    record = {'component': component, 'errorType': type(error).__name__}
    if isinstance(error, (RuntimeError, ValueError)) and re.fullmatch(r'[A-Z][A-Z0-9_]*', str(error)):
        record['errorCode'] = str(error)
    error_number = getattr(error, 'errno', None)
    if error_number is not None:
        record.update({'errno': error_number, 'errnoName': errno.errorcode.get(error_number, 'UNKNOWN')})
    if pid is not None:
        record['pid'] = pid
    if tid is not None:
        record['tid'] = tid
    return record


class ProcSampler:
    def __init__(self, root_pid, root_starttime, output, checkout, stop_file=None, interval=1.0, other_scope='accessible'):
        require_linux()
        if root_pid <= 0 or root_starttime < 0 or not math.isfinite(interval) or interval <= 0:
            raise ValueError('SAMPLER_ARGUMENT_INVALID')
        self.root = (root_pid, root_starttime)
        self.output = self.validate_evidence_path(output, checkout)
        self.stop_file = self.validate_evidence_path(stop_file, checkout) if stop_file else None
        if self.stop_file == self.output:
            raise ValueError('STOP_FILE_EQUALS_OUTPUT')
        if other_scope not in ('accessible', 'same-uid'):
            raise ValueError('OTHER_SCOPE_INVALID')
        self.interval = interval
        self.other_scope = other_scope
        self.clock_ticks = os.sysconf('SC_CLK_TCK')
        self.uid = os.getuid()
        self.observer_pid = os.getpid()
        self.stop_event = threading.Event()
        self.stop_reason = None
        self.known_tree = {self.root}
        self.previous_cpu = {}
        self.previous_threads = {}
        self.previous_io = {}
        self.previous_test_keys = set()
        self.sequence = 0
        self.started = time.monotonic()

    @staticmethod
    def validate_evidence_path(path, checkout):
        candidate = Path(path).resolve()
        checkout_root = Path(checkout).resolve()
        if not candidate.is_relative_to(checkout_root) or candidate == checkout_root:
            raise ValueError('EVIDENCE_MUST_BE_WITHIN_DECLARED_ACCEPTANCE_OUTPUT')
        if not candidate.parent.is_dir():
            raise ValueError('EVIDENCE_PARENT_MISSING')
        return candidate

    def request_stop(self, reason):
        self.stop_reason = reason
        self.stop_event.set()

    def read_stat(self, pid, errors, tid=None):
        try:
            path = PROC / str(pid)
            if tid is not None:
                path = path / 'task' / str(tid)
            record = parse_stat((path / 'stat').read_text(encoding='utf-8', errors='replace'))
            if record['pid'] != (tid if tid is not None else pid):
                raise ValueError('PROC_PID_MISMATCH')
            record['observedMonotonicSeconds'] = time.monotonic()
            return record
        except (OSError, ValueError) as error:
            errors.append(error_record('threadStat' if tid is not None else 'processStat', error, pid, tid))
            return None

    def cpu_record(self, record, previous, key):
        current_ticks = record['userTicks'] + record['systemTicks']
        prior = previous.get(key)
        result = {
            'userTicks': record['userTicks'],
            'systemTicks': record['systemTicks'],
            'totalTicks': current_ticks,
            'totalSeconds': current_ticks / self.clock_ticks,
            'deltaTicks': None,
            'deltaSeconds': None,
            'observationIntervalSeconds': None,
            'percentOfOneCpu': None,
            'deltaStatus': 'first_observation',
        }
        if prior is not None:
            elapsed = record['observedMonotonicSeconds'] - prior['observedMonotonicSeconds']
            delta = current_ticks - prior['totalTicks']
            if delta >= 0 and elapsed > 0:
                result.update({
                    'deltaTicks': delta,
                    'deltaSeconds': delta / self.clock_ticks,
                    'observationIntervalSeconds': elapsed,
                    'percentOfOneCpu': 100 * delta / self.clock_ticks / elapsed,
                    'deltaStatus': 'consecutive_samples' if prior['sequence'] == self.sequence - 1 else 'gap_since_previous_observation',
                })
            else:
                result['deltaStatus'] = 'counter_decreased_or_interval_invalid'
        previous[key] = {'totalTicks': current_ticks, 'observedMonotonicSeconds': record['observedMonotonicSeconds'], 'sequence': self.sequence}
        return result

    def read_io(self, pid, key, errors):
        try:
            values = {}
            for line in (PROC / str(pid) / 'io').read_text().splitlines():
                name, value = line.split(':', 1)
                if name in IO_FIELDS:
                    values[name] = int(value.strip())
            if set(values) != set(IO_FIELDS):
                raise ValueError('PROC_IO_FIELDS_MISSING')
            prior = self.previous_io.get(key)
            deltas = None
            delta_status = 'first_observation'
            if prior is not None:
                candidate = {name: values[name] - prior['counters'][name] for name in IO_FIELDS}
                if all(value >= 0 for value in candidate.values()):
                    deltas = candidate
                    delta_status = 'consecutive_samples' if prior['sequence'] == self.sequence - 1 else 'gap_since_previous_observation'
                else:
                    delta_status = 'counter_decreased'
            self.previous_io[key] = {'counters': values, 'sequence': self.sequence}
            return {'status': 'ok', 'counters': values, 'delta': deltas, 'deltaStatus': delta_status}
        except (OSError, ValueError) as error:
            failure = error_record('processIo', error, pid)
            errors.append(failure)
            return {'status': 'unavailable', 'error': failure}

    def read_threads(self, pid, process_key, errors):
        try:
            tids = sorted(int(entry.name) for entry in (PROC / str(pid) / 'task').iterdir() if entry.name.isdecimal())
        except OSError as error:
            errors.append(error_record('threadEnumeration', error, pid))
            return {'status': 'unavailable', 'threads': []}
        records = []
        for tid in tids:
            record = self.read_stat(pid, errors, tid)
            if record is None:
                continue
            records.append({
                'tid': tid,
                'starttimeTicks': record['starttimeTicks'],
                'comm': record['comm'],
                'state': record['state'],
                'roleHint': role_hint(record['comm']),
                'cpu': self.cpu_record(record, self.previous_threads, (process_key, identity(record))),
            })
        return {'status': 'ok' if len(records) == len(tids) else 'partial', 'enumeratedCount': len(tids), 'threads': records}

    def read_service_units(self, pid, process_key, errors):
        try:
            labels = parse_service_units((PROC / str(pid) / 'cgroup').read_text())
            after = self.read_stat(pid, errors)
            if after is None or identity(after) != process_key:
                raise ValueError('PROC_CGROUP_PROCESS_IDENTITY_UNAVAILABLE_OR_CHANGED')
            return labels
        except (OSError, ValueError) as error:
            failure = error_record('processCgroupServiceUnits', error, pid)
            errors.append(failure)
            return {'serviceUnits': [], 'serviceUnitsStatus': 'unavailable', 'serviceUnitInstancesRedacted': False, 'serviceUnitsError': failure}

    def select_tree(self, census, errors):
        selected = {key for key in self.known_tree if key[0] in census and identity(census[key[0]]) == key}
        changed = True
        validated_parents = {}
        while changed:
            changed = False
            for record in census.values():
                key = identity(record)
                if key in selected or record['pid'] == self.observer_pid:
                    continue
                parent = census.get(record['ppid'])
                if parent is None or identity(parent) not in selected or parent['starttimeTicks'] > record['starttimeTicks']:
                    continue
                parent_key = identity(parent)
                if parent_key not in validated_parents:
                    current = self.read_stat(parent['pid'], errors)
                    validated_parents[parent_key] = current is not None and identity(current) == parent_key
                if validated_parents[parent_key]:
                    selected.add(key)
                    changed = True
        self.known_tree.update(selected)
        return selected

    def sample(self):
        sample_started = time.monotonic()
        errors = []
        census = {}
        entries = sorted(int(entry.name) for entry in PROC.iterdir() if entry.name.isdecimal())
        excluded_uid = 0
        for pid in entries:
            record = self.read_stat(pid, errors)
            if record is None:
                continue
            if self.other_scope == 'same-uid':
                try:
                    record['sameUid'] = (PROC / str(pid)).stat().st_uid == self.uid
                except OSError as error:
                    errors.append(error_record('processOwner', error, pid))
                    record['sameUid'] = False
            census[pid] = record
        root_record = census.get(self.root[0])
        if root_record is not None and identity(root_record) != self.root:
            root_status = 'pid_reused'
        elif root_record is not None and root_record['state'] in ('Z', 'X', 'x'):
            root_status = 'exited'
        elif root_record is not None:
            root_status = 'running'
        elif any(error.get('pid') == self.root[0] and error.get('errno') not in (errno.ENOENT, errno.ESRCH) for error in errors):
            root_status = 'unavailable'
        else:
            root_status = 'gone'
        selected = self.select_tree(census, errors)
        test_records = []
        other_records = []
        observer_record = None
        for pid, record in census.items():
            key = identity(record)
            if key in selected:
                io_record = self.read_io(pid, key, errors)
                threads = self.read_threads(pid, key, errors)
                after = self.read_stat(pid, errors)
                if after is None or identity(after) != key:
                    errors.append({'component': 'processIdentityAfterDetails', 'pid': pid, 'starttimeTicks': key[1], 'errorType': 'IdentityUnavailableOrChanged'})
                    self.previous_io.pop(key, None)
                    continue
                test_records.append({
                    'pid': pid,
                    'starttimeTicks': key[1],
                    'ppid': after['ppid'],
                    'comm': after['comm'],
                    'state': after['state'],
                    'numThreads': after['numThreads'],
                    'roleHint': role_hint(after['comm']),
                    'membership': 'root' if key == self.root else 'observed_descendant_retained_by_identity',
                    'cpu': self.cpu_record(after, self.previous_cpu, key),
                    'io': io_record,
                    'threadObservationsNotAddedToProcessCpu': threads,
                })
            elif pid == self.observer_pid:
                observer_record = {'pid': pid, 'starttimeTicks': key[1], 'comm': record['comm'], 'cpu': self.cpu_record(record, self.previous_cpu, key)}
            elif self.other_scope == 'same-uid' and not record.get('sameUid'):
                excluded_uid += 1
            else:
                service_labels = self.read_service_units(pid, key, errors)
                other_records.append({'pid': pid, 'starttimeTicks': key[1], 'comm': record['comm'], 'cpu': self.cpu_record(record, self.previous_cpu, key), **service_labels})
        try:
            load_fields = (PROC / 'loadavg').read_text().split()
            runnable, tasks = load_fields[3].split('/')
            load = {'status': 'ok', 'oneMinute': float(load_fields[0]), 'fiveMinutes': float(load_fields[1]), 'fifteenMinutes': float(load_fields[2]), 'runnableTasks': int(runnable), 'totalTasks': int(tasks), 'lastPid': int(load_fields[4])}
        except (OSError, ValueError, IndexError) as error:
            failure = error_record('loadavg', error)
            errors.append(failure)
            load = {'status': 'unavailable', 'error': failure}
        eligible_deltas = [record['cpu']['deltaTicks'] for record in test_records if record['cpu']['deltaStatus'] == 'consecutive_samples' and (record['pid'], record['starttimeTicks']) in self.previous_test_keys]
        current_test_keys = {(record['pid'], record['starttimeTicks']) for record in test_records}
        result = {
            'type': 'sample',
            'sequence': self.sequence,
            'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'elapsedSeconds': sample_started - self.started,
            'monotonicSeconds': sample_started,
            'rootStatus': root_status,
            'loadavg': load,
            'testTree': {
                'processes': test_records,
                'liveObservedCpuTicks': sum(record['cpu']['totalTicks'] for record in test_records),
                'liveObservedCpuSeconds': sum(record['cpu']['totalSeconds'] for record in test_records),
                'consecutiveObservedCpuDeltaTicks': sum(eligible_deltas) if self.sequence else None,
                'consecutiveObservedCpuDeltaSeconds': sum(eligible_deltas) / self.clock_ticks if self.sequence else None,
                'consecutiveDeltaProcessCount': len(eligible_deltas),
                'processCount': len(test_records),
                'newlyObservedIdentities': [{'pid': pid, 'starttimeTicks': starttime} for pid, starttime in sorted(current_test_keys - self.previous_test_keys)],
                'noLongerObservedIdentities': [{'pid': pid, 'starttimeTicks': starttime} for pid, starttime in sorted(self.previous_test_keys - current_test_keys)],
                'vitestNamedWorkerCandidateProcessCount': sum(record['roleHint']['kind'] == 'vitest_named_worker_candidate' for record in test_records),
            },
            'otherProcesses': other_records,
            'observerProcess': observer_record,
            'coverage': {'enumeratedProcessCount': len(entries), 'readableStatProcessCount': len(census), 'excludedOtherUidCount': excluded_uid, 'otherScope': self.other_scope},
            'errors': errors,
            'sampleReadDurationSeconds': time.monotonic() - sample_started,
        }
        self.previous_test_keys = current_test_keys
        self.sequence += 1
        return result

    def run(self):
        with self.output.open('x', encoding='utf-8') as output:
            def write(record):
                output.write(json.dumps(record, ensure_ascii=True, separators=(',', ':')) + '\n')
                output.flush()

            write({
                'type': 'sampler_start',
                'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'rootIdentity': {'pid': self.root[0], 'starttimeTicks': self.root[1]},
                'observerPid': self.observer_pid,
                'clockTicksPerSecond': self.clock_ticks,
                'cpuCount': os.cpu_count(),
                'intervalSeconds': self.interval,
                'otherScope': self.other_scope,
                'limitations': [
                    'Snapshots are not atomic; processes and threads born and gone between samples can be missed.',
                    'Process utime+stime includes all threads; cutime/cstime and separate thread CPU are never added.',
                    'CPU deltas require two observations of the same PID+starttime; aggregate consecutive deltas omit missing endpoints and newly observed processes.',
                    'percentOfOneCpu uses each process observation interval and can exceed 100 for a multithreaded process.',
                    'Other processes are accessible non-test processes, not a verified inventory of service ownership.',
                    'Service unit labels are cgroup membership hints below system.slice/user.slice; delegated groups, namespaces, migration, and nested managers prevent definitive service ownership.',
                    'Instantiated service labels omit @instance data; complete cgroup paths are never retained.',
                    'Process comm names may be truncated or changed; worker candidate counts do not establish simultaneous test-file execution.',
                    'Process IO counters are recorded individually and not summed because waited-child IO can be included.',
                    'read_bytes/write_bytes describe storage accounting; rchar/wchar also include cached reads and other character IO.',
                    'No cmdline, environment, process working directories, executable paths, or service data are read.',
                    'Previously observed descendants remain in the test tree by exact identity after reparenting; unobserved reparented descendants can be missed.',
                ],
            })
            deadline = time.monotonic()
            try:
                while True:
                    if self.stop_file and self.stop_file.exists():
                        self.request_stop('stop_file')
                    sample = self.sample()
                    if sample['rootStatus'] in ('gone', 'exited', 'pid_reused') and not self.stop_event.is_set():
                        self.request_stop('root_' + sample['rootStatus'])
                    sample['finalSample'] = self.stop_event.is_set()
                    sample['stopReason'] = self.stop_reason if sample['finalSample'] else None
                    write(sample)
                    if sample['finalSample']:
                        break
                    deadline += self.interval
                    now = time.monotonic()
                    if deadline <= now:
                        skipped = math.floor((now - deadline) / self.interval) + 1
                        deadline += skipped * self.interval
                        write({'type': 'sampling_overrun', 'sequenceAfter': sample['sequence'], 'skippedScheduledSamples': skipped})
                    self.stop_event.wait(max(0.0, deadline - time.monotonic()))
            except Exception as error:
                write({'type': 'sampler_error', 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), **error_record('samplingLoop', error)})
                raise
            write({'type': 'sampler_stop', 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'reason': self.stop_reason, 'sampleCount': self.sequence, 'elapsedSeconds': time.monotonic() - self.started})


def main():
    parser = argparse.ArgumentParser(description='Read-only Linux /proc observer; never starts, signals, or stops the runner.')
    parser.add_argument('--root-pid', type=int, required=True)
    parser.add_argument('--root-starttime', type=int, required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--checkout', required=True)
    parser.add_argument('--stop-file')
    parser.add_argument('--interval', type=float, default=1.0)
    parser.add_argument('--other-scope', choices=('accessible', 'same-uid'), default='accessible')
    arguments = parser.parse_args()
    sampler = ProcSampler(arguments.root_pid, arguments.root_starttime, arguments.output, arguments.checkout, arguments.stop_file, arguments.interval, arguments.other_scope)
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda number, frame: sampler.request_stop('signal_' + signal.Signals(number).name))
    sampler.run()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        sys.stderr.write(json.dumps({'type': 'sampler_fatal', **error_record('main', error)}) + '\n')
        sys.exit(1)
