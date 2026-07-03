import json
import os
import sys
import types

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'lib')))

import mqttOutput


class FakeClient:
    '''records what would have been sent to the broker'''
    def __init__(self, *args, **kwargs):
        self.published = []
        self.will = None
        self.auth = None
        self.connected_to = None
        self.loop_started = False
        self.on_connect = None

    def username_pw_set(self, username, password):
        self.auth = (username, password)

    def will_set(self, topic, payload, retain=False):
        self.will = (topic, payload, retain)

    def connect_async(self, host, port):
        self.connected_to = (host, port)

    def loop_start(self):
        self.loop_started = True

    def loop_stop(self):
        self.loop_started = False

    def disconnect(self):
        pass

    def publish(self, topic, payload=None, retain=False):
        self.published.append((topic, payload, retain))

    def topics(self):
        return [topic for topic, payload, retain in self.published]


def make_config(**overrides):
    settings = {
        'mqtt_enabled': True,
        'mqtt_host': 'broker.local',
        'mqtt_port': 1883,
        'mqtt_topic_prefix': 'kiln',
        'mqtt_publish_interval': 0,
        'temp_scale': 'c',
        'currency_type': '$',
    }
    settings.update(overrides)
    return types.SimpleNamespace(**settings)


def make_state(**overrides):
    state = {
        'cost': 1.5,
        'runtime': 120,
        'temperature': 250.4,
        'target': 260.0,
        'state': 'RUNNING',
        'heat': 1.2,
        'heat_rate': 100.1,
        'totaltime': 3600,
        'profile': 'cone-6',
        'catching_up': False,
    }
    state.update(overrides)
    return json.dumps(state)


@pytest.fixture
def output(monkeypatch):
    monkeypatch.setattr(mqttOutput.mqtt, 'Client', FakeClient)
    return mqttOutput.MQTTOutput(make_config())


def test_connects_with_last_will(output):
    assert output.client.connected_to == ('broker.local', 1883)
    assert output.client.loop_started
    assert output.client.will == ('kiln/availability', 'offline', True)


def test_on_connect_publishes_availability_and_discovery(output):
    output._on_connect(output.client, None)
    assert output.client.published[0] == ('kiln/availability', 'online', True)
    topics = output.client.topics()
    assert 'homeassistant/sensor/kiln/temperature/config' in topics
    assert 'homeassistant/binary_sensor/kiln/heating/config' in topics
    # all discovery messages must be retained and reference the state topic
    for topic, payload, retain in output.client.published[1:]:
        assert retain
        config = json.loads(payload)
        assert config['state_topic'] == 'kiln/state'
        assert config['availability_topic'] == 'kiln/availability'
        assert config['device']['identifiers'] == ['kiln']


def test_discovery_uses_configured_temp_scale(monkeypatch):
    monkeypatch.setattr(mqttOutput.mqtt, 'Client', FakeClient)
    output = mqttOutput.MQTTOutput(make_config(temp_scale='f'))
    output._on_connect(output.client, None)
    payload = next(json.loads(p) for t, p, r in output.client.published
                   if t == 'homeassistant/sensor/kiln/temperature/config')
    assert payload['unit_of_measurement'] == '\N{DEGREE SIGN}F'


def test_discovery_can_be_disabled(monkeypatch):
    monkeypatch.setattr(mqttOutput.mqtt, 'Client', FakeClient)
    output = mqttOutput.MQTTOutput(make_config(mqtt_ha_discovery=False))
    output._on_connect(output.client, None)
    assert output.client.topics() == ['kiln/availability']


def test_send_publishes_state(output):
    output.send(make_state())
    topic, payload, retain = output.client.published[0]
    assert topic == 'kiln/state'
    assert retain
    assert json.loads(payload)['temperature'] == 250.4


def test_send_ignores_backlog_messages(output):
    output.send(json.dumps({'type': 'backlog', 'profile': None, 'log': []}))
    assert output.client.published == []


def test_send_never_raises(output):
    output.send("this is not json")
    assert output.client.published == []


def test_publish_interval_throttles(monkeypatch):
    monkeypatch.setattr(mqttOutput.mqtt, 'Client', FakeClient)
    output = mqttOutput.MQTTOutput(make_config(mqtt_publish_interval=60))
    output.send(make_state(temperature=100))
    output.send(make_state(temperature=101))
    assert len(output.client.published) == 1


def test_state_change_bypasses_throttle(monkeypatch):
    monkeypatch.setattr(mqttOutput.mqtt, 'Client', FakeClient)
    output = mqttOutput.MQTTOutput(make_config(mqtt_publish_interval=60))
    output.send(make_state(state='RUNNING'))
    output.send(make_state(state='IDLE'))
    assert len(output.client.published) == 2
