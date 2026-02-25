---
description: Cancel ALL pending schedules in this project
---
Use the schedule_list tool with statusFilter=pending.
Then for every pending entry, call schedule_cancel with its scheduleId
and reason "bulk clear by user".
Report how many were cancelled.
