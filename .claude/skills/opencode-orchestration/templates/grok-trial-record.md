# Grok trial record: <batch> (<date>)

| Item | Trial model | Comparison batches |
| --- | --- | --- |
| Model | `xai/<model>` | `<provider/model>`, batches <list> |
| Batch size | <items, files changed, test layers run> | <same, per batch> |
| Wall time to final stop file | <minutes> | <minutes each> |
| Tool calls | <n> | <n each> |
| Rework rounds | <n, one line per cause> | <n each> |
| Review findings | <blocking / should fix / minor counts> | <same> |
| False claims in stop files | <n, what was claimed and what was true> | <same> |
| Rule breaks | <deny-list hits, wrong host, commit or push rules> | <same> |
| Usage | <dashboard reading or "not provided"> | <cost from oc-events.py> |
| Start and end time | <local times, for the dashboard> | |

## Observations

<What the model did better or worse, with the evidence path for each point.>

## Recommendation

<Keep the current default / switch / run another trial, and why. The user decides.>
