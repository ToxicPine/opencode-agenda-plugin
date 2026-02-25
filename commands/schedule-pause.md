---
description: Pause the scheduler -- no pending schedules will fire until resumed
---
The scheduler has been paused. Pending schedules remain in the queue but
will not execute until you run /schedule-resume.

Write the JSON `{"paused": true}` to `.opencode/scheduler/config.json`
to persist this across restarts.
