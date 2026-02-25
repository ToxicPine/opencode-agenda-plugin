---
description: Cancel ALL pending agenda items in this project
subtask: true
---
Use the agenda_list tool with statusFilter=pending.
Then for every pending entry, call agenda_cancel with its agendaId
and reason "bulk clear by user".
Report how many were cancelled.
