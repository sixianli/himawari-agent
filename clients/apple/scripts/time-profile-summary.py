import sys
import xml.etree.ElementTree as ET
from collections import Counter


def main(path):
    tree = ET.parse(path)
    by_id = {}
    for element in tree.iter():
        identifier = element.get("id")
        if identifier is not None:
            by_id[identifier] = element

    def resolve(element):
        ref = element.get("ref")
        return by_id.get(ref, element) if ref is not None else element

    inclusive = Counter()
    leaf = Counter()
    total = 0
    for row in tree.iter("row"):
        thread = None
        backtrace = None
        for child in row:
            child = resolve(child)
            if child.tag == "thread":
                thread = child
            elif child.tag == "backtrace":
                backtrace = child
        if thread is None or backtrace is None:
            continue
        label = thread.get("fmt", "")
        if "Main Thread" not in label and "com.apple.main-thread" not in label:
            continue
        names = []
        for frame in backtrace.iter("frame"):
            frame = resolve(frame)
            names.append(frame.get("name", "?"))
        if not names:
            continue
        total += 1
        leaf[names[0]] += 1
        for name in set(names):
            inclusive[name] += 1

    print(f"TIME_PROFILE main-thread samples={total}")
    print("TIME_PROFILE top inclusive (share of main-thread samples):")
    for name, count in inclusive.most_common(80):
        print(f"  {count * 100 / max(total, 1):5.1f}%  {name[:160]}")
    print("TIME_PROFILE top self:")
    for name, count in leaf.most_common(40):
        print(f"  {count * 100 / max(total, 1):5.1f}%  {name[:160]}")


main(sys.argv[1])
