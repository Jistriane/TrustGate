alter table tasks drop constraint if exists tasks_status_check;

alter table tasks
  add constraint tasks_status_check check (status in ('OPEN', 'ASSIGNED', 'COMPLETING', 'COMPLETED', 'EXPIRED'));

