# ASCII diagram patterns

Every pattern below passes `scripts/check_ascii.py`; the skill's tests check this. Copy the closest pattern, change the labels, keep the column arithmetic, then run the checker on your version.

Rules every pattern follows:

- Corners and junctions are `+`. A vertical line touches a border only at a `+`.
- A vertical line ends at a `+` or an arrow (`v`, `^`). A horizontal line ends at a `+` or an arrow (`>`, `<`).
- Labels inside boxes are short ASCII words or a number such as `[1]`. Explanations in Chinese go in a numbered list under the code block.
- Put an edge label on the line above the edge or beside a vertical line, never inside the line.

## Flow: steps in order

```text
+-------+  push   +----+  webhook  +--------+
| local | ------> | CI | --------> | deploy |
+-------+         +----+           +--------+
```

## Branch: one source, several outcomes

The `+` on the bottom border of the source box sits in the box's middle column, and each arrow sits in the middle column of its target box.

```text
           +-----------+
           |  question |
           +-----+-----+
                 |
     +-----------+-----------+
     |           |           |
     v           v           v
 +-------+   +-------+   +-------+
 | [1]   |   | [2]   |   | [3]   |
 | text  |   | ascii |   | html  |
 +-------+   +-------+   +-------+
```

## Loop: retry until a check passes

```text
 +------+     +------+     +----------+  pass   +------+
 | plan | --> | draw | --> | check.py | ------> | show |
 +------+     +--+---+     +----+-----+         +------+
                 ^              | fail
                 |              |
                 +--------------+
```

## Layers: each layer calls the one below

```text
+----------------+
| browser        |
+-------+--------+
        |  HTTP
        v
+----------------+
| api server     |
+-------+--------+
        |  SQL
        v
+----------------+
| postgres       |
+----------------+
```

## Sequence: messages over time

Time runs downward. Each participant's line starts at a `+` on its box and ends with `v`.

```text
+--------+     +--------+     +----+
| client |     | server |     | db |
+---+----+     +---+----+     +-+--+
    |              |            |
    |  request     |            |
    +------------->|            |
    |              |  query     |
    |              +----------->|
    |              |  rows      |
    |              |<-----------+
    |  response    |            |
    |<-------------+            |
    v              v            v
```
