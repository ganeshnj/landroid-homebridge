'use strict';
const mqtt = require('mqtt');

const CLOUDS = {
  worx: { api: 'api.worxlandroid.com', login: 'https://id.worx.com/', clientId: '150da4d2-bb44-433b-9429-3773adc70a2a', prefix: 'WX' },
  kress: { api: 'api.kress-robotik.com', login: 'https://id.kress.com/', clientId: '931d4bc4-3192-405a-be78-98e43486dc59', prefix: 'KR' },
  landxcape: { api: 'api.landxcape-services.com', login: 'https://id.landxcape-services.com/', clientId: 'dec998a9-066f-433b-987a-f5fc54d3af7c', prefix: 'LX' },
  ferrex: { api: 'api.watermelon.smartmower.cloud', login: 'https://id.watermelon.smartmower.cloud/', clientId: '10078D10-3840-474A-848A-5EED949AB0FC', prefix: 'FE' },
};
const REFRESH_SCOPE = 'user:profile mower:firmware mower:view mower:pair user:manage mower:update mower:activity_log user:certificate data:products mower:unpair mower:warranty mobile:notifications mower:lawn';
// dat.ls status codes that mean "actively mowing / working"
const WORKING = new Set([2, 3, 4, 5, 6, 7, 12, 30, 31, 32]);
const CMD = { START: 1, STOP: 2, HOME: 3 };

module.exports = (api) => api.registerPlatform('WorxLandroid', WorxPlatform);

class WorxPlatform {
  constructor(log, config, api) {
    this.log = log; this.config = config; this.api = api;
    this.accessories = new Map();
    this.mowers = new Map(); // serial -> { info, handler }
    this.cloud = CLOUDS[config.server || 'worx'];
    if (!config.email || !config.password) return log.error('email and password are required');
    api.on('didFinishLaunching', () => this.start().catch((e) => log.error(`start failed: ${e.message}`)));
    api.on('shutdown', () => { clearTimeout(this.refreshTimer); this.client && this.client.end(true); });
  }

  configureAccessory(acc) { this.accessories.set(acc.UUID, acc); }

  async post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${url} -> HTTP ${r.status} ${await r.text()}`);
    return r.json();
  }

  async login() {
    this.session = await this.post(`${this.cloud.login}oauth/token`, {
      client_id: this.cloud.clientId, username: this.config.email, password: this.config.password, scope: '*', grant_type: 'password' });
    this.scheduleRefresh();
  }

  scheduleRefresh() {
    const ms = Math.max(60, (this.session.expires_in || 3600) - 300) * 1000;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh().catch((e) => this.log.error(`refresh failed: ${e.message}`)), ms);
  }

  async refresh() {
    this.session = await this.post(`${this.cloud.login}oauth/token`, {
      client_id: this.cloud.clientId, scope: REFRESH_SCOPE, refresh_token: this.session.refresh_token, grant_type: 'refresh_token' });
    this.scheduleRefresh();
    this.connectMqtt(); // custom-authorizer JWT is only checked at connect, so reconnect with the new token
  }

  async fetchMowers() {
    const r = await fetch(`https://${this.cloud.api}/api/v2/product-items?status=1&gps_status=1`, {
      headers: { authorization: `Bearer ${this.session.access_token}`, accept: 'application/json' } });
    if (!r.ok) throw new Error(`product-items -> HTTP ${r.status}`);
    return r.json();
  }

  async start() {
    await this.login();
    const items = await this.fetchMowers();
    this.log.info(`Found ${items.length} mower(s)`);
    const seen = new Set();
    for (const item of items) { seen.add(this.addMower(item)); }
    for (const [uuid, acc] of this.accessories) {
      if (!seen.has(uuid)) { this.api.unregisterPlatformAccessories('homebridge-worx-landroid-local', 'WorxLandroid', [acc]); this.accessories.delete(uuid); }
    }
    this.mqttInfo = { endpoint: items[0] && items[0].mqtt_endpoint || 'iot.eu-west-1.worxlandroid.com', userId: items[0] && items[0].user_id };
    this.connectMqtt();
  }

  addMower(item) {
    const { Service, Characteristic } = this.api.hap;
    const uuid = this.api.hap.uuid.generate(item.serial_number);
    let acc = this.accessories.get(uuid);
    if (!acc) {
      acc = new this.api.platformAccessory(item.name || item.serial_number, uuid);
      this.api.registerPlatformAccessories('homebridge-worx-landroid-local', 'WorxLandroid', [acc]);
      this.accessories.set(uuid, acc);
    }
    acc.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Worx')
      .setCharacteristic(Characteristic.Model, item.product && item.product.code || 'Landroid')
      .setCharacteristic(Characteristic.SerialNumber, item.serial_number);

    const sw = acc.getService(Service.Switch) || acc.addService(Service.Switch, item.name);
    const bat = acc.getService(Service.Battery) || acc.addService(Service.Battery, `${item.name} Battery`);
    const state = { on: false, level: 100, charging: false, low: false };
    sw.getCharacteristic(Characteristic.On)
      .onGet(() => state.on)
      .onSet((v) => this.command(item, v ? CMD.START : CMD.HOME));
    bat.getCharacteristic(Characteristic.BatteryLevel).onGet(() => state.level);
    bat.getCharacteristic(Characteristic.ChargingState).onGet(() => (state.charging ? 1 : 0));
    bat.getCharacteristic(Characteristic.StatusLowBattery).onGet(() => (state.low ? 1 : 0));

    const apply = (payload) => {
      const d = payload && payload.dat; if (!d) return;
      if (d.ls != null) state.on = WORKING.has(d.ls);
      if (d.bt) { state.level = d.bt.p; state.charging = !!d.bt.c; state.low = d.bt.p <= 20; }
      sw.updateCharacteristic(Characteristic.On, state.on);
      bat.updateCharacteristic(Characteristic.BatteryLevel, state.level)
        .updateCharacteristic(Characteristic.ChargingState, state.charging ? 1 : 0)
        .updateCharacteristic(Characteristic.StatusLowBattery, state.low ? 1 : 0);
    };
    this.mowers.set(item.serial_number, { item, apply });
    if (item.last_status && item.last_status.payload) apply(item.last_status.payload);
    return uuid;
  }

  connectMqtt() {
    if (this.client) this.client.end(true);
    const parts = this.session.access_token.replace(/_/g, '/').replace(/-/g, '+').split('.');
    const clientId = `${this.cloud.prefix}/USER/${this.mqttInfo.userId}/homebridge/${this.api.hap.uuid.generate(this.config.email)}`;
    this.client = mqtt.connect(`wss://${this.mqttInfo.endpoint}:443/mqtt`, {
      clientId, clean: false, reconnectPeriod: 5000, protocolVersion: 4,
      wsOptions: { headers: {
        'x-amz-customauthorizer-name': 'com-worxlandroid-customer',
        'x-amz-customauthorizer-signature': parts[2],
        jwt: `${parts[0]}.${parts[1]}` } },
    });
    this.client.on('connect', () => {
      this.log.info('MQTT connected');
      for (const { item } of this.mowers.values()) this.client.subscribe(item.mqtt_topics.command_out, { qos: 1 });
    });
    this.client.on('message', (topic, msg) => {
      let data; try { data = JSON.parse(msg.toString()); } catch { return; }
      for (const m of this.mowers.values()) if (m.item.mqtt_topics.command_out === topic) m.apply(data);
    });
    this.client.on('error', (e) => this.log.warn(`MQTT error: ${e.message}`));
  }

  command(item, cmd) {
    this.log.info(`${item.name}: cmd ${cmd}`);
    if (!this.client || !this.client.connected) throw new this.api.hap.HapStatusError(-70402);
    this.client.publish(item.mqtt_topics.command_in, JSON.stringify({ cmd }), { qos: 1 });
  }
}
