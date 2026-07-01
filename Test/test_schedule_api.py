import importlib.util
import io
import json
import os

import pytest

# kiln-controller.py has a dash in its name, so import it by path.
# importing it instantiates the (simulated) oven as a daemon thread.
def load_controller():
    path = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'kiln-controller.py'))
    spec = importlib.util.spec_from_file_location("kiln_controller", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

controller = load_controller()


@pytest.fixture(autouse=True)
def profile_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(controller, "profile_path", str(tmp_path))
    # keep responses in the units the tests submit
    monkeypatch.setattr(controller.config, "temp_scale", "c")
    return tmp_path


def api(method, path, body=None):
    '''drive the bottle app through the wsgi interface'''
    payload = json.dumps(body).encode() if body is not None else b''
    environ = {
        'REQUEST_METHOD': method,
        'PATH_INFO': path,
        'QUERY_STRING': '',
        'SERVER_NAME': 'localhost',
        'SERVER_PORT': '8081',
        'SERVER_PROTOCOL': 'HTTP/1.1',
        'CONTENT_TYPE': 'application/json',
        'CONTENT_LENGTH': str(len(payload)),
        'wsgi.version': (1, 0),
        'wsgi.url_scheme': 'http',
        'wsgi.input': io.BytesIO(payload),
        'wsgi.errors': io.StringIO(),
        'wsgi.multithread': False,
        'wsgi.multiprocess': False,
        'wsgi.run_once': False,
    }
    captured = {}
    def start_response(status, headers, exc_info=None):
        captured['status'] = int(status.split(' ', 1)[0])
    raw = b''.join(controller.app(environ, start_response))
    return captured['status'], json.loads(raw) if raw else None


def make_schedule(name="api-test", data=None):
    return {
        "name": name,
        "type": "profile",
        "data": data or [[0, 65], [3600, 1000]],
        "temp_units": "c",
    }


def test_list_schedules_empty():
    status, body = api('GET', '/api/schedules')
    assert status == 200
    assert body == []


def test_create_and_get_schedule(profile_dir):
    status, body = api('POST', '/api/schedules', make_schedule())
    assert status == 201
    assert body == {"success": True, "schedule": "api-test"}
    assert (profile_dir / "api-test.json").exists()

    status, body = api('GET', '/api/schedules/api-test')
    assert status == 200
    assert body["name"] == "api-test"

    status, body = api('GET', '/api/schedules')
    assert status == 200
    assert [profile["name"] for profile in body] == ["api-test"]


def test_create_duplicate_schedule_conflicts():
    status, _ = api('POST', '/api/schedules', make_schedule())
    assert status == 201

    status, body = api('POST', '/api/schedules', make_schedule())
    assert status == 409
    assert body["success"] is False


def test_create_schedule_rejects_bad_payloads():
    for payload in (
        {},  # no name
        {"name": "x"},  # no data
        make_schedule(name="../escape"),  # path traversal
        make_schedule(data=[[0, 65]]),  # too few points
        make_schedule(data=[[0, 65], ["soon", 1000]]),  # non numeric point
        make_schedule(data=[[0, 65], [3600]]),  # malformed point
    ):
        status, body = api('POST', '/api/schedules', payload)
        assert status == 400, payload
        assert body["success"] is False


def test_put_creates_then_updates():
    status, _ = api('PUT', '/api/schedules/api-test', make_schedule())
    assert status == 201

    updated = make_schedule(data=[[0, 65], [3600, 1100]])
    status, body = api('PUT', '/api/schedules/api-test', updated)
    assert status == 200
    assert body == {"success": True, "schedule": "api-test"}

    status, body = api('GET', '/api/schedules/api-test')
    assert status == 200
    assert body["data"] == [[0, 65], [3600, 1100]]


def test_put_defaults_name_from_url():
    schedule = make_schedule()
    del schedule["name"]
    status, _ = api('PUT', '/api/schedules/api-test', schedule)
    assert status == 201

    status, body = api('GET', '/api/schedules/api-test')
    assert status == 200
    assert body["name"] == "api-test"


def test_put_rejects_mismatched_name():
    status, body = api('PUT', '/api/schedules/other-name', make_schedule())
    assert status == 400
    assert body["success"] is False


def test_delete_schedule(profile_dir):
    api('POST', '/api/schedules', make_schedule())

    status, body = api('DELETE', '/api/schedules/api-test')
    assert status == 200
    assert body == {"success": True, "schedule": "api-test"}
    assert not (profile_dir / "api-test.json").exists()

    status, _ = api('DELETE', '/api/schedules/api-test')
    assert status == 404


def test_get_missing_schedule_404():
    status, body = api('GET', '/api/schedules/nope')
    assert status == 404
    assert body["success"] is False
