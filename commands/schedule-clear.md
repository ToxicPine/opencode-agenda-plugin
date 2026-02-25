---
description: Cancel ALL pending scheduled commands
---
Use the schedule_list tool with statusFilter=pending.
Then for every pending entry, call schedule_cancel with its scheduleId
and reason "bulk clear by user".
Report how many were cancelled.
