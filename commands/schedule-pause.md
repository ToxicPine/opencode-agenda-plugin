---
description: Pause the scheduler -- no pending commands will fire until resumed
---
The scheduler has been paused. Pending commands remain in the queue but
will not execute until you run /schedule-resume.

Write the JSON `{"paused": true}` to `.opencode/scheduler/config.json`
to persist this across restarts.
