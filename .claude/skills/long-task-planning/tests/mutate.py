import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
FILES = ("scripts/longtask.py", "tests/test_longtask.py", "tests/junit_report.py", "tests/test_junit_report.py")
TEXT = {rel: (SKILL / rel).read_text(encoding="utf-8") for rel in FILES}

M = []


def mutant(name, replacements, tests, target="scripts/longtask.py", module="test_longtask"):
    M.append((name, replacements, tests, target, module))


mutant("task dir counted in fingerprint",
       [('    if path.startswith(TASKS_DIR + "/") or is_junk(path):\n        return True', '    if is_junk(path):\n        return True')],
       ["FingerprintTests.test_task_directory_does_not_count", "StatusTests.test_task_directory_edits_keep_verified"])
mutant("junk files counted",
       [('    return name in JUNK_NAMES or name.startswith("._")', '    return False')],
       ["FingerprintTests.test_finder_files_are_ignored_without_global_excludes"])
mutant("configured excludes ignored",
       [('    return under_any(path, excludes)', '    return False')],
       ["FingerprintTests.test_configured_exclude_is_ignored"])
mutant("fingerprint command ignores task excludes",
       [('        excludes += [value for value in path_list(data, "exclude") if value not in excludes]', '        pass')],
       ["FingerprintTests.test_configured_exclude_is_ignored"])
mutant("include ignored",
       [('    return excluded(path, excludes) or (bool(includes) and not under_any(path, includes))', '    return excluded(path, excludes)')],
       ["IncludeTests.test_include_limits_the_fingerprint_to_listed_paths"])
mutant("include matches names that only start with the prefix",
       [('        if prefix and (path == prefix or path.startswith(prefix + "/")):', '        if prefix and path.startswith(prefix):')],
       ["IncludeTests.test_include_limits_the_fingerprint_to_listed_paths"])
mutant("exclude ignored inside include",
       [('    return excluded(path, excludes) or (bool(includes)', '    return excluded(path, []) or (bool(includes)')],
       ["IncludeTests.test_include_limits_the_fingerprint_to_listed_paths"])
mutant("fingerprint command ignores task include",
       [('        includes += [value for value in path_list(data, "include") if value not in includes]', '        pass')],
       ["IncludeTests.test_fingerprint_command_reads_include_and_accepts_the_flag"])
mutant("include flag ignored",
       [('    includes = list(args.include or [])', '    includes = []')],
       ["IncludeTests.test_fingerprint_command_reads_include_and_accepts_the_flag"])
mutant("include paths unchecked in lint",
       [('        errors += include_problems(task.repo, path_list(data, "include"))', '        pass')],
       ["IncludeTests.test_include_paths_must_exist"])
mutant("include problems not shown by status",
       [(' + self.record_errors + include_problems(self.repo, self.scope[0])\n', ' + self.record_errors\n')],
       ["IncludeTests.test_include_paths_must_exist"])
mutant("include type unchecked",
       [('    if not (isinstance(include, list) and all(isinstance(value, str) for value in include)):', '    if False:')],
       ["IncludeTests.test_include_paths_must_exist"])
mutant("every include path reported missing",
       [('            for value in includes if not any(under_any(path, [value]) for path in files)]', '            for value in includes]')],
       ["IncludeTests.test_include_paths_must_exist"])
mutant("status hides the include paths",
       [('    if report["include"]:\n        lines.insert', '    if False:\n        lines.insert')],
       ["IncludeTests.test_status_shows_the_include_paths"])
mutant("scope not recorded",
       [('    fingerprint["scope"] = scope_record(scope)\n', '')],
       ["IncludeTests.test_scope_change_is_named_instead_of_code_change"])
mutant("scope change reported as a code change",
       [('        if recorded is not None and recorded != current:', '        if False:')],
       ["IncludeTests.test_scope_change_is_named_instead_of_code_change", "IncludeTests.test_remote_fingerprint_with_other_scope_is_named"])
mutant("scope compared unsorted",
       [('    return {"include": sorted(set(includes)), "exclude": sorted(set(excludes))}', '    return {"include": list(includes), "exclude": list(excludes)}')],
       ["IncludeTests.test_scope_change_is_named_instead_of_code_change"])
mutant("empty file list left unexplained",
       [('        elif not changed:\n            reason = (', '        elif False:\n            reason = (')],
       ["IncludeTests.test_scope_change_is_named_instead_of_code_change"])
mutant("remote scope not read",
       [('        recorded = scope_record((data.get("includes") or [], data["excludes"] or [])) if "excludes" in data else None', '        recorded = None')],
       ["IncludeTests.test_remote_fingerprint_with_other_scope_is_named"])
mutant("remote scope hint missing",
       [('            if record.get("host") != local_host():\n                reason +=', '            if False:\n                reason +=')],
       ["IncludeTests.test_remote_fingerprint_with_other_scope_is_named"])
mutant("mode always 100644",
       [('    return "100755" if info.st_mode & stat.S_IXUSR else "100644"', '    return "100644"')],
       ["FingerprintTests.test_mode_change_changes_fingerprint"])
mutant("deleted file kept",
       [('            if not os.path.lexists(repo / path):\n                entries.pop(path, None)', '            if False:\n                entries.pop(path, None)')],
       ["FingerprintTests.test_deleted_tracked_file_changes_fingerprint"])
mutant("untracked files skipped",
       [('    pending.update(path for path in untracked_files(repo) if not outside_scope(path, scope))', '    pass')],
       ["FingerprintTests.test_untracked_file_counts_and_ignored_file_does_not"])
mutant("porcelain diff for worktree changes",
       [('    pending.update(path for path in split_z(git_out(repo, "diff-files", "--name-only", "-z"))', '    pending.update(path for path in split_z(git_out(repo, "diff", "--name-only", "-z", "--no-renames"))')],
       ["FingerprintTests.test_fingerprint_does_not_write_into_git_directory"])
mutant("porcelain diff for changed files",
       [('            old = tree_entries(self.repo, commit, self.scope)\n            result = sorted(path for path in set(old) | set(self.entries) if old.get(path) != self.entries.get(path))', '            result = sorted(split_z(git_out(self.repo, "diff", "--name-only", "-z", "--no-renames", commit)))')],
       ["StatusTests.test_reading_commands_do_not_write_into_git_directory"])
mutant("global ignore rules disabled",
       [('    return split_z(git_out(repo, "ls-files", "-o", "--exclude-standard", "-z"))', '    return split_z(git_out(repo, "-c", "core.excludesFile=/dev/null", "ls-files", "-o", "--exclude-standard", "-z"))')],
       ["FingerprintTests.test_global_ignore_rules_apply_like_git_status"])
mutant("dirty always false",
       [('    dirty = not head or digest_lines(tree_entries(repo, head, scope)) != fingerprint', '    dirty = not head')],
       ["FingerprintTests"])
mutant("remote host accepted without fingerprint file",
       [('    if args.host and args.host != local:\n        raise Fail(', '    if False:\n        raise Fail(')],
       ["RecordTests.test_remote_host_without_fingerprint_file_is_refused"])
mutant("report paths not mapped",
       [('        path = mapper.first(names)\n        if path is None:\n            path = names[0] if names else ""', '        path = None\n        if path is None:\n            path = names[0] if names else ""')],
       ["RecordTests.test_vitest_report_counts_tags_with_repository_paths"])
mutant("evidence overwritten",
       [('    with open(path, "a+", encoding="utf-8") as handle:', '    with open(path, "w+", encoding="utf-8") as handle:')],
       ["RecordTests.test_evidence_file_is_only_appended"])
mutant("junit error ignored",
       [('        if case.find("failure") is not None or case.find("error") is not None:', '        if case.find("failure") is not None:')],
       ["RecordTests.test_junit_report_is_parsed"])
mutant("selector results not recorded",
       [('            if path == file_rel and name in full:', '            if False:')],
       ["RecordTests.test_selected_tests_are_recorded_for_selector_checks", "StatusTests.test_selector_check_states"])
mutant("retractions ignored",
       [('    return [record for record in records if record.get("kind") != "retract" and record["id"] not in retracted]', '    return [record for record in records if record.get("kind") != "retract"]')],
       ["StatusTests.test_failure_on_current_code_blocks_until_retracted"])
mutant("current failure does not block",
       [('            if failed:\n                count = sum(', '            if False:\n                count = sum(')],
       ["StatusTests.test_failure_on_current_code_blocks_until_retracted"])
mutant("tagged files need not all run",
       [('            missing = [path for path in files if path not in ran]', '            missing = []')],
       ["StatusTests.test_every_tagged_file_must_run_on_current_code"])
mutant("vanished tag is not_done",
       [('            if seen:\n                return "unknown", f"测试标签', '            if False:\n                return "unknown", f"测试标签')],
       ["StatusTests.test_tag_seen_before_but_missing_now_is_unknown"])
mutant("docs count as test files",
       [('def is_test_file(path):\n    name', 'def is_test_file(path):\n    return True\n    name')],
       ["StatusTests.test_tag_in_docs_does_not_count_as_test_file"])
mutant("host restriction ignored",
       [('        return host is None or record.get("host") == host', '        return True')],
       ["StatusTests.test_host_restriction"])
mutant("review ignores file changes",
       [('        changed = sorted(path for path, blob in files.items() if current.get(path) != blob)', '        changed = []')],
       ["StatusTests.test_review_check_follows_reviewed_file_contents"])
mutant("rejected review accepted",
       [('        if latest.get("verdict") != "approved":', '        if False:')],
       ["StatusTests.test_rejected_review_is_not_done"])
mutant("priority reversed",
       [('STATUS_PRIORITY = ("unknown", "waiting", "not_done", "older", "verified")', 'STATUS_PRIORITY = ("verified", "older", "not_done", "waiting", "unknown")')],
       ["StatusTests.test_combined_checks_use_priority"])
mutant("older never reported",
       [('            if sum(value.get("passed", 0) for value in group) and not sum(value.get("failed", 0) for value in group):\n                return self.older(record, what)', '            if False:\n                return self.older(record, what)')],
       ["StatusTests.test_verified_then_older_after_code_change"])
mutant("changed files not listed",
       [('            result = sorted(path for path in set(old) | set(self.entries) if old.get(path) != self.entries.get(path))', '            result = []')],
       ["StatusTests.test_verified_then_older_after_code_change"])
mutant("withdrawn ref unchecked",
       [('            if ref in self.goal_ids:\n                result.update(status="withdrawn"', '            if True:\n                result.update(status="withdrawn"')],
       ["StatusTests.test_withdrawn_items"])
mutant("user ref unchecked",
       [('        if ref in self.goal_ids:\n            return "verified", f"你的决定见', '        if True:\n            return "verified", f"你的决定见')],
       ["StatusTests.test_user_decision_states"])
mutant("doc heading unchecked",
       [('            if not found:\n                return "not_done", f"{rel} 里还没有', '            if False:\n                return "not_done", f"{rel} 里还没有')],
       ["StatusTests.test_doc_check"])
mutant("command exit code ignored",
       [('            failed = [record for record in current if record.get("exit_code") != 0]', '            failed = []')],
       ["StatusTests.test_command_check"])
mutant("selector name not searched",
       [('        if name not in full.read_text(encoding="utf-8", errors="replace"):', '        if False:')],
       ["StatusTests.test_selector_check_states"])
mutant("unfinished item hides older checks",
       [('        shown = STATUS_PRIORITY if result["status"] == "verified" else STATUS_PRIORITY[:-1]', '        shown = (result["status"],)')],
       ["StatusTests.test_unfinished_item_lists_every_check_still_needed"])
mutant("unfinished item lists verified checks",
       [('        shown = STATUS_PRIORITY if result["status"] == "verified" else STATUS_PRIORITY[:-1]', '        shown = STATUS_PRIORITY')],
       ["StatusTests.test_unfinished_item_lists_every_check_still_needed"])
mutant("init error omits the directory",
       [('        raise Fail(f"{home_short(start)} 不在 git 仓库里；长任务的完整模式需要 git 仓库")', '        raise Fail("当前目录不在 git 仓库里")')],
       ["InitTests.test_init_outside_a_repository_names_the_directory"])
mutant("template hint missing",
       [('            hint = "标题由模板拼成时（含 %s 之类），name 只写源码里原样出现的一段"', '            hint = ""')],
       ["StatusTests.test_selector_name_must_appear_verbatim_in_the_source"])
mutant("unknown fingerprints merged",
       [('            if fingerprint == UNKNOWN_FINGERPRINT:\n                group = [counts_of(record)]', '            if False:\n                group = [counts_of(record)]')],
       ["StatusTests.test_backfilled_reports_with_unknown_fingerprints_are_not_merged"])
mutant("every older record judged alone",
       [('            if fingerprint == UNKNOWN_FINGERPRINT:\n                group = [counts_of(record)]', '            if True:\n                group = [counts_of(record)]')],
       ["StatusTests.test_pass_and_failure_on_the_same_older_code_do_not_count_as_passed"])
mutant("report time not recorded",
       [('    if started:\n        record["ran_at"] = iso(started)', '    if False:\n        record["ran_at"] = iso(started)')],
       ["RecordTests.test_report_run_time_is_recorded"])
mutant("junit uses the latest suite time",
       [('    started = min(aware or moments) if moments else None', '    started = max(aware or moments) if moments else None')],
       ["RecordTests.test_report_run_time_is_recorded"])
mutant("record time shown as run time",
       [('''        when = short_time(record["ran_at"]) if record.get("ran_at") else f"记录于 {short_time(record.get('time'))}"''', '''        when = short_time(record.get('time'))''')],
       ["StatusTests.test_older_evidence_shows_when_the_tests_ran"])
mutant("placeholder names pass lint",
       [('    if isinstance(selector, str) and TEMPLATE_PLACEHOLDER.search(selector):', '    if False:')],
       ["LintTests.test_selector_name_with_a_template_placeholder_is_refused"])
mutant("placeholder names judged as normal selectors",
       [('            problem = placeholder_problem(check["name"])\n            if problem:\n                return "unknown", problem, []', '            problem = placeholder_problem(check["name"])\n            if False:\n                return "unknown", problem, []')],
       ["LintTests.test_selector_name_with_a_template_placeholder_is_refused"])
mutant("missing goal ref ignored",
       [('        missing = [ref for ref in entry.get("goal_ref") or [] if ref not in self.goal_ids]', '        missing = []')],
       ["StatusTests.test_missing_goal_reference_is_unknown"])
mutant("status exit code always 0",
       [('    return 2 if report["counts"]["unknown"] else 0', '    return 0')],
       ["StatusTests"])
mutant("snapshot never saved",
       [('    if not args.no_save:\n        save_snapshot(task, report)', '    if False:\n        save_snapshot(task, report)')],
       ["StatusTests.test_changes_since_last_saved_status"])
mutant("no changes since last",
       [('    if not previous:\n        return []', '    if True:\n        return []')],
       ["StatusTests.test_changes_since_last_saved_status"])
mutant("goal rewrite allowed",
       [('    errors += append_only_errors(file_versions(task, "goal.md"), "goal.md", norm_lines)', '    pass')],
       ["LintTests.test_goal_must_only_grow", "LintTests.test_committed_goal_rewrite_is_found_in_history"])
mutant("history limited to last commit",
       [('    commits = git_out(task.repo, "log", "-n", "200", "--format=%H", "--", path).split()', '    commits = git_out(task.repo, "log", "-n", "1", "--format=%H", "--", path).split()')],
       ["LintTests.test_committed_goal_rewrite_is_found_in_history"])
mutant("evidence rewrite allowed",
       [('    errors += append_only_errors(file_versions(task, "evidence.jsonl"), "evidence.jsonl", norm_lines, may_insert=True)', '    pass')],
       ["LintTests.test_evidence_must_only_grow"])
mutant("evidence insertions refused",
       [('"evidence.jsonl", norm_lines, may_insert=True)', '"evidence.jsonl", norm_lines)')],
       ["LintTests.test_evidence_lines_inserted_between_committed_lines_pass"])
mutant("evidence order ignored",
       [('    remaining = iter(new)\n    return all(line in remaining for line in old)', '    return all(line in new for line in old)')],
       ["LintTests.test_evidence_reordered_or_removed_committed_lines_fail"])
mutant("goal insertions allowed",
       [('    errors += append_only_errors(file_versions(task, "goal.md"), "goal.md", norm_lines)', '    errors += append_only_errors(file_versions(task, "goal.md"), "goal.md", norm_lines, may_insert=True)')],
       ["LintTests.test_goal_line_inserted_between_old_lines_fails"])
mutant("plan log insertions allowed",
       [('lambda text, name=name: section_lines(text, name))', 'lambda text, name=name: section_lines(text, name), may_insert=True)')],
       ["LintTests.test_goal_line_inserted_between_old_lines_fails"])
mutant("unreadable evidence time accepted",
       [('        if record_moment(record) is None:\n            errors.append(', '        if False:\n            errors.append(')],
       ["LintTests.test_evidence_time_must_be_readable"])
mutant("records kept in file order",
       [('        self.records = in_time_order(effective_records(self.all_records))', '        self.records = effective_records(self.all_records)')],
       ["ReviewTests.test_latest_review_is_chosen_by_time_not_line_order",
        "EnvironmentCheckTests.test_latest_environment_record_is_chosen_by_time_not_line_order"])
mutant("record time sorted as text",
       [('        moment = record_moment(record)\n        return (moment is not None, moment or 0.0)', '        return str(record.get("time"))')],
       ["EnvironmentCheckTests.test_latest_environment_record_is_chosen_by_time_not_line_order"])
mutant("status words allowed",
       [('            match = None if in_comment else STATUS_WORDS.search(line)', '            match = None')],
       ["LintTests.test_status_words_and_checkboxes_only_allowed_in_logs"])
mutant("batch limit four",
       [('        if len(batch) > 3:', '        if len(batch) > 4:')],
       ["LintTests.test_current_batch_is_limited_to_three_items"])
mutant("batch counts items mentioned anywhere in a line",
       [("            found = pattern.match(line, bullet.end())", "            found = pattern.search(line)")],
       ["LintTests.test_batch_counts_only_lines_that_start_with_an_item"])
mutant("batch checks only counted items exist",
       [("        for value in dict.fromkeys(mentioned):", "        for value in batch:")],
       ["LintTests.test_batch_counts_only_lines_that_start_with_an_item"])
mutant("condition change needs no log",
       [('            if changed and not any(item_id in line for line in added_lines):', '            if False:')],
       ["LintTests.test_changed_completion_condition_needs_a_log_line"])
mutant("item removal allowed",
       [('            if item_id not in after:\n                errors.append(', '            if item_id not in after:\n                continue\n                errors.append(')],
       ["LintTests.test_removing_an_item_is_refused"])
mutant("log sections editable",
       [('        errors += append_only_errors(plan_versions, f"plan.md 的“{name}”", lambda text, name=name: section_lines(text, name))', '        pass')],
       ["LintTests.test_log_sections_must_only_grow"])
mutant("duplicate id allowed",
       [('        if item_id in seen:\n            errors.append(f"条目编号 {item_id} 重复")', '        if False:\n            errors.append(f"条目编号 {item_id} 重复")')],
       ["LintTests.test_invalid_items_are_reported"])
mutant("prefix unchecked",
       [('        elif prefix and not item_id.startswith(prefix + "-"):', '        elif False:')],
       ["LintTests.test_invalid_items_are_reported"])
mutant("goal ref unchecked in lint",
       [('                if ref not in goal_ids:\n                    errors.append(f"条目 {name} 对应的目标', '                if False:\n                    errors.append(f"条目 {name} 对应的目标')],
       ["LintTests.test_invalid_items_are_reported"])
mutant("empty done_when allowed",
       [('        if not may_be_empty and not (isinstance(checks, list) and checks):\n            errors.append(f"条目 {name} 没有完成条件', '        if False:\n            errors.append(f"条目 {name} 没有完成条件')],
       ["LintTests.test_invalid_items_are_reported"])
mutant("unknown check type allowed",
       [('    if kind not in CHECK_TYPES:\n        return [f"条目 {name} 的完成条件类型', '    if False:\n        return [f"条目 {name} 的完成条件类型')],
       ["LintTests.test_invalid_items_are_reported"])
mutant("context budget ignored",
       [('    for settings in ((6, 160, 6, 120), (4, 110, 4, 100), (3, 70, 3, 80), (2, 50, 2, 60)):\n        for questions in (True, False):\n            text = render(*settings, questions)\n            if len(text) <= budget:\n                return text\n    return text[: budget - 8] + "……（已截断）"', '    return render(1000, 100000, 1000, 100000, True)')],
       ["ContextHookTests.test_context_stays_within_budget"])
mutant("reminder on every start",
       [('        if source in SOURCE_EVENTS:\n            return REMINDER.format(event=SOURCE_EVENTS[source],', '        if True:\n            return REMINDER.format(event=SOURCE_EVENTS.get(source, ""),')],
       ["ContextHookTests.test_repository_without_task_reminds_only_after_compact_or_resume"])
mutant("closed task injected",
       [('    return any(entry["id"] == "CLOSED" for entry in entries)', '    return False')],
       ["ContextHookTests.test_closed_task_is_not_injected"])
mutant("hook ignores cwd",
       [('        cwd = Path(payload.get("cwd") or os.getcwd())', '        cwd = Path(os.getcwd())')],
       ["ContextHookTests.test_hook_uses_cwd_from_input"])
mutant("brief withdrawn accepted",
       [('    withdrawn = [value for value in batch if value in items and items[value].get("withdrawn")]', '    withdrawn = []')],
       ["CheckBriefTests.test_brief_with_withdrawn_item_fails"])
mutant("brief withdrawn refused outside the batch",
       [('    withdrawn = [value for value in batch if value in items and items[value].get("withdrawn")]', '    withdrawn = [value for value in mentioned if value in items and items[value].get("withdrawn")]')],
       ["CheckBriefTests.test_withdrawn_item_outside_the_batch_only_warns"])
mutant("brief withdrawn mention not warned",
       [('        if noted:\n            print(', '        if False:\n            print(')],
       ["CheckBriefTests.test_withdrawn_item_outside_the_batch_only_warns"])
mutant("brief batch taken from the whole brief",
       [('        bullet = None if level is None else re.match(', '        bullet = re.match(')],
       ["CheckBriefTests.test_batch_is_the_id_led_bullets_in_the_scope_section",
        "CheckBriefTests.test_item_mentioned_only_outside_the_scope_section_is_not_a_batch"])
mutant("brief batch counts any mention",
       [('        found = bullet and pattern.match(line, bullet.end())', '        found = bullet and pattern.search(line)')],
       ["CheckBriefTests.test_item_mentioned_only_outside_the_scope_section_is_not_a_batch"])
mutant("brief code fences read as headings",
       [('        if fenced:\n            continue\n', '')],
       ["CheckBriefTests.test_batch_is_the_id_led_bullets_in_the_scope_section"])
mutant("brief subheading ends the scope",
       [('            if level is None or depth <= level:', '            if True:')],
       ["CheckBriefTests.test_batch_is_the_id_led_bullets_in_the_scope_section"])
mutant("brief backtick before the id not allowed",
       [('        bullet = None if level is None else re.match(r"^\\s*[-*]\\s+`?", line)', '        bullet = None if level is None else re.match(r"^\\s*[-*]\\s+", line)')],
       ["CheckBriefTests.test_brief_naming_known_items_passes"])
mutant("brief without batch accepted",
       [('    if not batch:\n        problems.append(', '    if False:\n        problems.append(')],
       ["CheckBriefTests.test_item_mentioned_only_outside_the_scope_section_is_not_a_batch"])
mutant("brief batch limit four",
       [('    if len(batch) > 3:\n        problems.append(', '    if len(batch) > 4:\n        problems.append(')],
       ["CheckBriefTests.test_brief_batch_is_limited_to_three_items"])
mutant("brief batch counts duplicates",
       [('        if found and found.group(0) not in batch:\n            batch.append', '        if found:\n            batch.append')],
       ["CheckBriefTests.test_brief_batch_is_limited_to_three_items"])
mutant("brief unknown accepted",
       [('    unknown = [value for value in mentioned if value not in items]', '    unknown = []')],
       ["CheckBriefTests.test_brief_with_unknown_item_fails"])
mutant("test exclusions ignored",
       [('        return self.current(record) or self.untested_changes(record) is not None', '        return self.current(record)')],
       ["TestExcludeTests.test_doc_only_change_keeps_test_evidence_current"])
mutant("tested commit not matched to the fingerprint",
       [("for candidate in [commit, *later.stdout.split()] if self.tree_digest(candidate) == fingerprint), None)", "for candidate in [commit, *later.stdout.split()]), None)")],
       ["TestExcludeTests.test_uncommitted_or_unknown_test_records_are_not_relaxed"])
mutant("later commits not searched for the tested content",
       [("for candidate in [commit, *later.stdout.split()] if", "for candidate in [commit] if")],
       ["TestExcludeTests.test_evidence_recorded_before_its_commit_is_relaxed_from_that_commit"])
mutant("relaxed note names the recorded commit",
       [("        commits = sorted({self.untested_changes(record)[0][:7] for record in relaxed})", "        commits = sorted({(record.get('commit') or '')[:7] for record in relaxed})")],
       ["TestExcludeTests.test_evidence_recorded_before_its_commit_is_relaxed_from_that_commit"])
mutant("every change treated as untested",
       [('            untested_only = changed is not None and all(excluded(path, self.test_excludes) for path in changed)', '            untested_only = changed is not None')],
       ["TestExcludeTests.test_code_change_after_doc_only_change_is_older"])
mutant("relaxed failures ignored",
       [('            failed = [record for record in current if record["tags"][tag].get("failed", 0)]', '            failed = [record for record in current if self.current(record) and record["tags"][tag].get("failed", 0)]')],
       ["TestExcludeTests.test_failure_then_doc_only_change_stays_not_done"])
mutant("commands follow test exclusions",
       [('        current = [record for record in relevant if self.current(record)]\n        if ignore:\n            current = [record for record in relevant if self.test_current(record)]', '        current = [record for record in relevant if self.test_current(record)]\n        if ignore:\n            current = [record for record in relevant if self.test_current(record)]')],
       ["TestExcludeTests.test_commands_and_reviews_ignore_test_exclude"])
mutant("never-committed code fingerprint ignored",
       [('        return record["code_fingerprint"] == code_digest(self.entries, self.test_excludes)', '        return True')],
       ["TestExcludeTests.test_never_committed_alone_later_code_change_is_older"])
mutant("changed test_exclude list ignored",
       [('        if recorded != sorted(set(self.test_excludes)):\n            return False', '        if False:\n            return False')],
       ["TestExcludeTests.test_never_committed_alone_changed_test_exclude_is_older"])
mutant("untested files not limited to test_exclude",
       [('                    changed = sorted(path for path in changed if under_any(path, self.test_excludes))', '                    changed = changed')],
       ["TestExcludeTests.test_never_committed_alone_doc_change_keeps_evidence_current"])
mutant("dirty record note hidden",
       [('        if any(self.tested_commit(record) is None and record.get("dirty") for record in relaxed):', '        if False:')],
       ["TestExcludeTests.test_never_committed_alone_doc_change_keeps_evidence_current"])
mutant("command switch always accepted",
       [('        ignore = check.get("ignore_test_exclude") is True', '        ignore = True')],
       ["TestExcludeTests.test_commands_and_reviews_ignore_test_exclude",
        "TestExcludeTests.test_ignore_test_exclude_command_follows_doc_only_change"])
mutant("command switch never accepted",
       [('        ignore = check.get("ignore_test_exclude") is True', '        ignore = False')],
       ["TestExcludeTests.test_ignore_test_exclude_command_follows_doc_only_change"])
mutant("ignore_test_exclude type unchecked",
       [('    if "ignore_test_exclude" in check and not isinstance(check["ignore_test_exclude"], bool):', '    if False:')],
       ["LintTests.test_ignore_test_exclude_lint_requires_a_boolean"])
mutant("ignore_test_exclude with environment scope unchecked",
       [('    if "ignore_test_exclude" in check and check.get("scope") == "environment":', '    if False:')],
       ["LintTests.test_ignore_test_exclude_lint_refuses_environment_scope"])
mutant("selector ignores test exclusions",
       [('        current_records = [record for record in relevant if self.test_current(record)]', '        current_records = [record for record in relevant if self.current(record)]')],
       ["TestExcludeTests.test_doc_only_change_keeps_test_evidence_current"])
mutant("test_exclude unchecked in lint",
       [('    if not (isinstance(test_exclude, list) and all(isinstance(value, str) for value in test_exclude)):', '    if False:')],
       ["TestExcludeTests.test_test_exclude_must_be_a_list_of_paths"])
mutant("relaxed note hidden",
       [('                    if check["changed_files"]:\n', '                    if False:\n')],
       ["TestExcludeTests.test_doc_only_change_keeps_test_evidence_current"])
mutant("relaxed files counted as item changes",
       [('            if status == "verified":\n                continue\n            for path in changed:', '            for path in changed:')],
       ["TestExcludeTests.test_doc_only_change_keeps_test_evidence_current"])
mutant("review commit ignored",
       [('        hashes = commit_blobs(repo, reviewed, paths) if reviewed else hash_paths(repo, paths)', '        hashes = hash_paths(repo, paths)')],
       ["ReviewTests.test_backfilled_review_binds_to_the_reviewed_commit", "ReviewTests.test_review_commit_must_contain_the_files"])
mutant("directory accepted as a reviewed file",
       [('        found[path] = parts[2] if len(parts) == 3 and parts[1] == "blob" and name == path else None', '        found[path] = parts[2] if len(parts) == 3 else None')],
       ["ReviewTests.test_review_commit_must_contain_the_files"])
mutant("commit without review accepted",
       [('    if args.commit and not args.review:\n        raise Fail(', '    if False:\n        raise Fail(')],
       ["ReviewTests.test_review_commit_must_contain_the_files"])
mutant("reviewed commit not stored",
       [('        if reviewed:\n            record["reviewed_commit"] = reviewed', '        if False:\n            record["reviewed_commit"] = reviewed')],
       ["ReviewTests.test_backfilled_review_binds_to_the_reviewed_commit"])
mutant("file-less review without note accepted",
       [('        if args.no_files and not args.note:\n            raise Fail(', '        if False:\n            raise Fail(')],
       ["ReviewTests.test_review_without_files_needs_a_note"])
mutant("file-less review mixed with files accepted",
       [('        if args.no_files and (args.files or args.commit):\n            raise Fail(', '        if False:\n            raise Fail(')],
       ["ReviewTests.test_review_without_files_needs_a_note"])
mutant("file-less review hides its note",
       [('        if not files:\n            return "verified", f"{latest.get(\'by\')} 在', '        if False:\n            return "verified", f"{latest.get(\'by\')} 在')],
       ["ReviewTests.test_review_without_files_ignores_code_changes"])
mutant("environment scope ignored",
       [('        if "scope" in check:\n            problem = environment_problem(check)\n            if problem:\n                return "unknown"', '        if False:\n            problem = environment_problem(check)\n            if problem:\n                return "unknown"')],
       ["EnvironmentCheckTests"])
mutant("environment age not checked",
       [('        if now() - moment > dt.timedelta(days=days):', '        if False:')],
       ["EnvironmentCheckTests.test_environment_command_check_follows_age_not_code"])
mutant("environment failure ignored",
       [('        if latest.get("exit_code") != 0:\n            return "not_done", f"“{run}”在 {host} 上最近一次', '        if False:\n            return "not_done", f"“{run}”在 {host} 上最近一次')],
       ["EnvironmentCheckTests.test_environment_command_check_follows_age_not_code"])
mutant("environment host ignored",
       [('                   and record.get("command") == run and record.get("host") == host]', '                   and record.get("command") == run]')],
       ["EnvironmentCheckTests.test_environment_command_check_follows_age_not_code"])
mutant("environment oldest record decides",
       [('        latest = records[-1]', '        latest = records[0]')],
       ["EnvironmentCheckTests.test_environment_command_check_follows_age_not_code"])
mutant("environment lint unchecked",
       [('    elif kind == "command" and "scope" in check:\n        problem', '    elif False:\n        problem')],
       ["EnvironmentCheckTests.test_environment_command_check_needs_host_and_max_age"])
mutant("zero max age accepted",
       [('    if isinstance(days, bool) or not isinstance(days, int) or days < 1:', '    if not isinstance(days, int):')],
       ["EnvironmentCheckTests.test_environment_command_check_needs_host_and_max_age"])
mutant("withdrawn items left out of the total",
       [('    total = sum(counts.values())', '    total = sum(value for key, value in counts.items() if key != "withdrawn")')],
       ["StatusTests.test_total_counts_withdrawn_items"])
mutant("brief status keeps the reasons",
       [("        print(format_brief(report))", "        print(format_status(report, previous))")],
       ["StatusTests.test_brief_status_prints_one_line_per_item"])
mutant("brief status ignores the display order",
       [("    for status in DISPLAY_ORDER:\n        lines += [f\"{entry['id']}  {LABELS[status]}  {entry['title']}\" for entry in report[\"items\"] if entry[\"status\"] == status]",
         "    for entry in report[\"items\"]:\n        lines += [f\"{entry['id']}  {LABELS[entry['status']]}  {entry['title']}\"]")],
       ["StatusTests.test_brief_status_prints_one_line_per_item"])
mutant("brief and json allowed together",
       [("    status_format = status.add_mutually_exclusive_group()\n", "    status_format = status\n")],
       ["StatusTests.test_brief_status_prints_one_line_per_item"])
mutant("goal question not shown",
       [('            if questions and entry["question"]:\n', '            if False:\n')],
       ["ContextHookTests.test_context_shows_the_question_with_the_answer"])
mutant("goal question repeated in the answer",
       [("        lines = [line for line in lines if not line.strip().startswith(QUESTION_PREFIX)]\n", "")],
       ["ContextHookTests.test_context_shows_the_question_with_the_answer"])
mutant("fingerprint file dirty optional",
       [('FINGERPRINT_FILE_FIELDS = ("fingerprint", "commit", "dirty")', 'FINGERPRINT_FILE_FIELDS = ("fingerprint", "commit")')],
       ["RecordTests.test_fingerprint_file_error_lists_required_fields"])
mutant("fingerprint file error example incomplete",
       [('"dirty": False, "host": "<主机名>"}', '"dirty": False}')],
       ["RecordTests.test_fingerprint_file_error_lists_required_fields"])
mutant("commit and review progress words allowed",
       [("已提交|已合并|已推送|已审核|已做完|做完了|待验证|待审核|", "")],
       ["LintTests.test_commit_and_review_progress_words_are_refused"])
mutant("progress hint missing",
       [('PROGRESS_HINT = "计划只写做什么、用什么证据，不写到哪一步了；做没做完用 status 算"', 'PROGRESS_HINT = "计划只写打算，做没做完用 status 算"')],
       ["LintTests.test_commit_and_review_progress_words_are_refused"])
mutant("withdrawn items still need completion conditions",
       [('        may_be_empty = entry.get("withdrawn") is not None and checks in (None, [])', '        may_be_empty = False')],
       ["LintTests.test_withdrawn_item_may_have_no_completion_conditions"])
mutant("empty completion conditions allowed for every item",
       [('        may_be_empty = entry.get("withdrawn") is not None and checks in (None, [])', '        may_be_empty = checks in (None, [])')],
       ["LintTests.test_withdrawn_item_may_have_no_completion_conditions"])
mutant("goals shown in record order",
       [('    goals = goals[:1] + sorted(goals[1:], key=lambda entry: entry["date"])\n', '')],
       ["ContextHookTests.test_context_orders_goals_by_date_after_the_first"])
mutant("first goal sorted with the rest",
       [('    goals = goals[:1] + sorted(goals[1:], key=', '    goals = sorted(goals, key=')],
       ["ContextHookTests.test_context_orders_goals_by_date_after_the_first"])
mutant("formatter reminder missing",
       [("        if (repo / name).is_file():", "        if False:")],
       ["InitTests.test_init_reminds_to_skip_task_files_when_a_formatter_is_configured"])
mutant("formatter reminder ignores prettier",
       [('    ".prettierrc", ".prettierrc.json",', '    ".prettierrc.json",')],
       ["InitTests.test_init_reminds_to_skip_task_files_when_a_formatter_is_configured"])
mutant("formatter reminder always shown",
       [("        if (repo / name).is_file():", "        if name == FORMATTER_CONFIGS[0]:")],
       ["InitTests.test_init_reminds_to_skip_task_files_when_a_formatter_is_configured"])
mutant("install path resolved through the symlink",
       [("SCRIPT_PATH = Path(os.path.abspath(__file__))", "SCRIPT_PATH = Path(__file__).resolve()")],
       ["ContextHookTests.test_symlinked_install_reports_the_install_path"])
mutant("find-tests picks fragments from the full name",
       [("        fragment = title_fragment(title, texts[path])", "        fragment = title_fragment(full, texts[path])")],
       ["FindTestsTests.test_find_tests_prints_checks_that_verify_after_recording"])
mutant("find-tests prefers the shortest fragment",
       [("key=lambda span: (text.count(span), -len(span))", "key=lambda span: (text.count(span), len(span))")],
       ["FindTestsTests.test_find_tests_prints_checks_that_verify_after_recording"])
mutant("find-tests prefers the longest fragment",
       [("key=lambda span: (text.count(span), -len(span))", "key=lambda span: -len(span)")],
       ["FindTestsTests.test_find_tests_prefers_template_words_to_parameter_values"])
mutant("find-tests keeps fragments missing from the file",
       [("    found = [span for span in found if span in text]\n", "")],
       ["FindTestsTests.test_find_tests_prints_checks_that_verify_after_recording"])
mutant("find-tests ignores grep",
       [("        if (word is None or word in full.casefold()) and", "        if True and")],
       ["FindTestsTests.test_find_tests_filters_by_commit_and_word"])
mutant("find-tests grep is case sensitive",
       [("word in full.casefold()", "word in full")],
       ["FindTestsTests.test_find_tests_filters_by_commit_and_word"])
mutant("find-tests ignores commit",
       [("and (changed is None or path in changed):", "and True:")],
       ["FindTestsTests.test_find_tests_filters_by_commit_and_word"])
mutant("find-tests repeats checks",
       [("        if (path, fragment) in printed:\n            continue\n", "")],
       ["FindTestsTests.test_find_tests_prints_checks_that_verify_after_recording"])
mutant("find-tests hides shared fragments",
       [("        if matches > 1:", "        if matches > 2:")],
       ["FindTestsTests.test_find_tests_prints_checks_that_verify_after_recording"])
mutant("find-tests lists skipped tests",
       [('        if status == "skipped":\n            skipped += 1\n            continue\n', "")],
       ["FindTestsTests.test_find_tests_filters_by_commit_and_word"])
mutant("find-tests hides unmapped files",
       [('    notes += [f"报告里的文件 {name} 在仓库里找不到，它的测试没有列出" for name in sorted(unmapped)]\n', "")],
       ["FindTestsTests.test_find_tests_filters_by_commit_and_word"])
mutant("find-tests silent when nothing matches",
       [('    if not chosen:\n        notes.append("报告里没有符合条件的测试，没有列出任何检查")\n', "")],
       ["FindTestsTests.test_find_tests_filters_by_commit_and_word"])
mutant("find-tests says nothing matched when checks were printed",
       [("    if not chosen:\n", "    if not printed:\n")],
       ["FindTestsTests.test_find_tests_filters_by_commit_and_word"])
mutant("junit title missing",
       [('status, name or classname))', 'status, classname))')],
       ["FindTestsTests.test_find_tests_filters_by_commit_and_word"])
mutant("questions crowd out goals",
       [("        for questions in (True, False):", "        for questions in (True,):")],
       ["ContextHookTests.test_context_drops_questions_before_goals"])
mutant("junit subtest failures ignored",
       [('        if err is not None:\n            outcome = "failure"', '        if False:\n            outcome = "failure"')],
       ["JUnitReportTests.test_report_marks_every_outcome"], target="tests/junit_report.py", module="test_junit_report")
mutant("junit errors reported as failures",
       [('        self.mark(test, "error", str(err[1]), err)', '        self.mark(test, "failure", str(err[1]), err)')],
       ["JUnitReportTests.test_report_marks_every_outcome"], target="tests/junit_report.py", module="test_junit_report")
mutant("junit file attribute missing",
       [('        if path:\n            case.set("file", path)', '        if False:\n            case.set("file", path)')],
       ["JUnitReportTests.test_report_marks_every_outcome"], target="tests/junit_report.py", module="test_junit_report")
mutant("junit exit code ignores failures",
       [('    return 1 if totals["failure"] or totals["error"] else 0', '    return 0')],
       ["JUnitReportTests.test_report_marks_every_outcome"], target="tests/junit_report.py", module="test_junit_report")
mutant("junit run time missing",
       [('        "timestamp": started.isoformat(timespec="seconds"),\n', '')],
       ["JUnitReportTests.test_recorded_report_satisfies_selector_checks"], target="tests/junit_report.py", module="test_junit_report")
mutant("unclassified goals accepted",
       [('    missing = decision_missing(data, goal_entries)\n    if missing:', '    missing = decision_missing(data, goal_entries)\n    if False:')],
       ["DecisionTests.test_unclassified_durable_decision_is_reported"])
mutant("durable decisions need no item",
       [('    unlinked = decision_unlinked(data, goal_entries, items)\n    if unlinked:', '    unlinked = decision_unlinked(data, goal_entries, items)\n    if False:')],
       ["DecisionTests.test_durable_decision_needs_a_qualified_item"])
mutant("quotes always found",
       [('        missing = [ref for ref in quotes if normalize_quote(self.goal_texts[ref]) not in document]', '        missing = []')],
       ["DecisionTests.test_durable_decision_quote_must_appear_verbatim"])
mutant("quote whitespace kept",
       [('    return re.sub(r"\\s+", "", "".join(lines))', '    return "".join(lines)')],
       ["DecisionTests.test_durable_decision_quote_must_appear_verbatim"])
mutant("quote marker kept",
       [('        line = line.lstrip().removeprefix(">")', '        line = line.lstrip()')],
       ["DecisionTests.test_durable_decision_quote_must_appear_verbatim"])
mutant("decision docs prefix ignored",
       [('                if isinstance(path, str) and under_any(path, docs) and gid in quotes_of(check):',
         '                if isinstance(path, str) and gid in quotes_of(check):')],
       ["DecisionTests.test_durable_decision_docs_prefix"])
mutant("durable downgrade needs no record",
       [('                    if not any(word.search(line) for line in added_lines):', '                    if False:')],
       ["DecisionTests.test_durable_decision_downgrade_needs_a_plan_record"])
mutant("goal ids matched as substrings",
       [('                    word = re.compile(rf"(?<![A-Za-z0-9]){re.escape(gid)}(?![0-9])")', '                    word = re.compile(re.escape(gid))')],
       ["DecisionTests.test_durable_decision_downgrade_needs_a_plan_record"])
mutant("init writes no decisions",
       [('    items = {"task": args.task, "prefix": args.prefix, "decisions": {"G1": "once"}, "items": []}',
         '    items = {"task": args.task, "prefix": args.prefix, "items": []}')],
       ["DecisionTests.test_init_writes_durable_decision_default"])
mutant("tasks without decisions are checked",
       [('def decision_errors(data, goal_entries, items):\n    if "decisions" not in data:\n        return []',
         'def decision_errors(data, goal_entries, items):\n    if False:\n        return []')],
       ["DecisionTests.test_task_without_durable_decision_key_keeps_old_behaviour"])
mutant("removing decisions needs no record",
       [('                if not any("decisions" in line for line in added_lines):\n                    errors.append("items.json 删掉了 decisions',
         '                if False:\n                    errors.append("items.json 删掉了 decisions')],
       ["DecisionTests.test_removing_durable_decision_key_needs_a_plan_record"])
mutant("unknown quote goal accepted",
       [('        unknown = [ref for ref in quotes if ref not in self.goal_ids]\n        if unknown:',
         '        unknown = []\n        if unknown:')],
       ["DecisionTests.test_durable_decision_quote_needs_a_known_goal"])
mutant("decision values unchecked",
       [('        if value not in DECISION_VALUES:', '        if False:')],
       ["DecisionTests.test_invalid_durable_decision_fields_fail_lint"])
mutant("decision docs type unchecked",
       [("    if not (isinstance(value, list) and all(isinstance(item, str) for item in value)):\n        errors.append('items.json 的 decision_docs",
         "    if False:\n        errors.append('items.json 的 decision_docs")],
       ["DecisionTests.test_invalid_durable_decision_fields_fail_lint"])


def mutated(replacements, target):
    code = TEXT[target]
    for old, new in replacements:
        count = code.count(old)
        if count != 1:
            return None, f"pattern found {count} times: {old[:60]!r}"
        code = code.replace(old, new)
    return code, None


def run(selected):
    unknown = sorted(selected - {entry[0] for entry in M})
    if unknown:
        print(f"没有这些变异：{', '.join(unknown)}")
        return 1
    root = Path(tempfile.mkdtemp(prefix="longtask-mut-"))
    survived = []
    try:
        for index, (name, replacements, tests, target, module) in enumerate(M):
            if selected and name not in selected:
                continue
            code, problem = mutated(replacements, target)
            if problem:
                print(f"BAD  {name}: {problem}")
                survived.append(name)
            else:
                work = root / str(index)
                (work / "scripts").mkdir(parents=True)
                (work / "tests").mkdir()
                for rel, original in TEXT.items():
                    (work / rel).write_text(code if rel == target else original, encoding="utf-8")
                result = subprocess.run(
                    [sys.executable, "-m", "unittest", *[f"{module}.{test}" for test in tests]],
                    cwd=work / "tests", capture_output=True, text=True, check=False,
                    env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
                )
                verdict = "KILLED" if result.returncode != 0 else "SURVIVED"
                if verdict == "SURVIVED":
                    survived.append(name)
                tail = result.stderr.strip().splitlines()[-1] if result.stderr.strip() else ""
                print(f"{verdict:8} {name}  ({tail})", flush=True)
                shutil.rmtree(work)
    finally:
        shutil.rmtree(root, ignore_errors=True)
    print(f"\n{len(selected) if selected else len(M)} of {len(M)} mutants run, survived: {survived}")
    return 1 if survived else 0


if __name__ == "__main__":
    sys.exit(run(set(sys.argv[1:])))
