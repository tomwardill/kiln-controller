start a run

    curl -d '{"cmd":"run", "profile":"cone-05-long-bisque"}' -H "Content-Type: application/json" -X POST http://0.0.0.0:8081/api

skip the first part of a run
restart the kiln on a specific profile and start at minute 60

    curl -d '{"cmd":"run", "profile":"cone-05-long-bisque","startat":60}' -H "Content-Type: application/json" -X POST http://0.0.0.0:8081/api

stop a schedule

    curl -d '{"cmd":"stop"}' -H "Content-Type: application/json" -X POST http://0.0.0.0:8081/api

post a memo

    curl -d '{"cmd":"memo", "memo":"some significant message"}' -H "Content-Type: application/json" -X POST http://0.0.0.0:8081/api

stats for currently running schedule

    curl -X GET http://0.0.0.0:8081/api/stats

pause a run (maintain current temperature until resume)

    curl -d '{"cmd":"pause"}' -H "Content-Type: application/json" -X POST http://0.0.0.0:8081/api

resume a paused run
    
    curl -d '{"cmd":"resume"}' -H "Content-Type: application/json" -X POST http://0.0.0.0:8081/api

## Schedule management

Schedules (also called profiles) can be managed over HTTP. A schedule is a
json object with a `name`, a `type` of `profile`, a `data` list of
`[seconds, temperature]` points and optionally `temp_units` (`"c"` or `"f"`,
temperatures are assumed to be in the configured `temp_scale` and stored in
celsius when omitted).

list all schedules

    curl -X GET http://0.0.0.0:8081/api/schedules

get a single schedule (returns 404 if it does not exist)

    curl -X GET http://0.0.0.0:8081/api/schedules/cone-05-long-bisque

create a schedule (returns 409 if one with the same name already exists)

    curl -d '{"name":"my-schedule", "type":"profile", "data":[[0,65],[3600,1000]], "temp_units":"c"}' -H "Content-Type: application/json" -X POST http://0.0.0.0:8081/api/schedules

create or overwrite a schedule (the name in the url must match the body if given there)

    curl -d '{"name":"my-schedule", "type":"profile", "data":[[0,65],[3600,1100]], "temp_units":"c"}' -H "Content-Type: application/json" -X PUT http://0.0.0.0:8081/api/schedules/my-schedule

delete a schedule (returns 404 if it does not exist)

    curl -X DELETE http://0.0.0.0:8081/api/schedules/my-schedule
