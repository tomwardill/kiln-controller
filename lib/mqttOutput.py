import atexit
import json
import logging
import time

import paho.mqtt.client as mqtt

log = logging.getLogger(__name__)


class MQTTOutput:
    '''Publish oven state to an MQTT broker.

    This is output only - nothing is subscribed to and no commands are
    accepted over MQTT. It implements the same send() interface as the
    websocket observers, so it can be registered with
    OvenWatcher.add_observer().

    If mqtt_ha_discovery is enabled, retained Home Assistant discovery
    messages are published on every (re)connect so the kiln shows up
    automatically as a device with its sensors.
    '''

    def __init__(self, config):
        self.prefix = getattr(config, 'mqtt_topic_prefix', 'kiln')
        self.state_topic = '%s/state' % self.prefix
        self.availability_topic = '%s/availability' % self.prefix
        self.publish_interval = getattr(config, 'mqtt_publish_interval', 5)
        self.ha_discovery = getattr(config, 'mqtt_ha_discovery', True)
        self.discovery_prefix = getattr(config, 'mqtt_ha_discovery_prefix', 'homeassistant')
        self.device_name = getattr(config, 'mqtt_device_name', 'Kiln')
        # a single path component for use in topics and unique ids
        self.node_id = self.prefix.replace('/', '_')
        self.temp_unit = '\N{DEGREE SIGN}C' if getattr(config, 'temp_scale', 'f') == 'c' else '\N{DEGREE SIGN}F'
        self.currency_type = getattr(config, 'currency_type', '$')

        self.last_publish = 0
        self.last_state = None

        client_id = getattr(config, 'mqtt_client_id', 'kiln-controller')
        try:
            # paho-mqtt >= 2.0
            self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=client_id)
        except AttributeError:
            self.client = mqtt.Client(client_id=client_id)

        username = getattr(config, 'mqtt_username', None)
        if username:
            self.client.username_pw_set(username, getattr(config, 'mqtt_password', None))

        # let the broker tell everyone we went away
        self.client.will_set(self.availability_topic, 'offline', retain=True)
        self.client.on_connect = self._on_connect

        host = getattr(config, 'mqtt_host', 'localhost')
        port = getattr(config, 'mqtt_port', 1883)
        log.info("publishing to mqtt broker %s:%d as %s" % (host, port, self.state_topic))
        # connect_async + loop_start retries in the background, so a broker
        # that is down does not stop the kiln from running
        self.client.connect_async(host, port)
        self.client.loop_start()
        atexit.register(self._shutdown)

    # paho v1 and v2 pass different arguments, we need none of them
    def _on_connect(self, client, userdata, *args):
        log.info("mqtt connected")
        client.publish(self.availability_topic, 'online', retain=True)
        if self.ha_discovery:
            self._publish_discovery()

    def _shutdown(self):
        try:
            self.client.publish(self.availability_topic, 'offline', retain=True)
            self.client.loop_stop()
            self.client.disconnect()
        except Exception:
            pass

    def send(self, message_json):
        '''observer interface used by OvenWatcher.notify_all()'''
        try:
            message = json.loads(message_json)
            # ignore the backlog replay sent to new observers
            if not isinstance(message, dict) or 'temperature' not in message:
                return
            now = time.time()
            state_changed = message.get('state') != self.last_state
            if not state_changed and now - self.last_publish < self.publish_interval:
                return
            self.last_publish = now
            self.last_state = message.get('state')
            self.client.publish(self.state_topic, json.dumps(message), retain=True)
        except Exception:
            # never raise: OvenWatcher drops observers whose send() fails
            log.exception("could not publish state to mqtt")

    def _discovery_sensors(self):
        return [
            ('sensor', 'temperature', {
                'name': 'Temperature',
                'device_class': 'temperature',
                'unit_of_measurement': self.temp_unit,
                'state_class': 'measurement',
                'value_template': '{{ value_json.temperature | round(1) }}',
            }),
            ('sensor', 'target', {
                'name': 'Target temperature',
                'device_class': 'temperature',
                'unit_of_measurement': self.temp_unit,
                'state_class': 'measurement',
                'value_template': '{{ value_json.target | round(1) }}',
            }),
            ('sensor', 'heat_rate', {
                'name': 'Heat rate',
                'unit_of_measurement': '%s/h' % self.temp_unit,
                'state_class': 'measurement',
                'icon': 'mdi:thermometer-chevron-up',
                'value_template': '{{ value_json.heat_rate | round(1) }}',
            }),
            ('sensor', 'state', {
                'name': 'State',
                'icon': 'mdi:fire',
                'value_template': '{{ value_json.state }}',
            }),
            ('sensor', 'profile', {
                'name': 'Schedule',
                'icon': 'mdi:chart-line',
                'value_template': "{{ value_json.profile if value_json.profile else 'none' }}",
            }),
            ('sensor', 'runtime', {
                'name': 'Runtime',
                'device_class': 'duration',
                'unit_of_measurement': 's',
                'value_template': '{{ value_json.runtime | round(0) }}',
            }),
            ('sensor', 'totaltime', {
                'name': 'Schedule length',
                'device_class': 'duration',
                'unit_of_measurement': 's',
                'value_template': '{{ value_json.totaltime | round(0) }}',
            }),
            ('sensor', 'cost', {
                'name': 'Cost',
                'unit_of_measurement': self.currency_type,
                'icon': 'mdi:cash',
                'value_template': '{{ value_json.cost | round(2) }}',
            }),
            ('binary_sensor', 'heating', {
                'name': 'Heating',
                'device_class': 'heat',
                'value_template': "{{ 'ON' if value_json.heat else 'OFF' }}",
            }),
            ('binary_sensor', 'catching_up', {
                'name': 'Catching up',
                'value_template': "{{ 'ON' if value_json.catching_up else 'OFF' }}",
            }),
        ]

    def _publish_discovery(self):
        device = {
            'identifiers': [self.node_id],
            'name': self.device_name,
            'manufacturer': 'kiln-controller',
        }
        for component, key, extra in self._discovery_sensors():
            payload = {
                'unique_id': '%s_%s' % (self.node_id, key),
                'state_topic': self.state_topic,
                'availability_topic': self.availability_topic,
                'device': device,
            }
            payload.update(extra)
            topic = '%s/%s/%s/%s/config' % (self.discovery_prefix, component, self.node_id, key)
            self.client.publish(topic, json.dumps(payload), retain=True)
        log.info("published home assistant discovery for %d entities" % len(self._discovery_sensors()))
