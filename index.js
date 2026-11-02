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
const CMD = { START: 1, STOP: 2, HOME: 3, START_ONCE: 10, RESUME: 102 }; // ids from the Worx app's command enum
const PLUGIN_NAME = 'homebridge-worx-landroid-local';
const PLATFORM_NAME = 'WorxLandroid';

// Matter RVC operational states: 0 stopped, 1 running, 2 paused, 3 error, 64 seeking charger, 65 charging, 66 docked
function rvcState(dat) {
  if (dat.le > 0) return 3;
  switch (dat.ls) {
    case 1: return dat.bt && dat.bt.c ? 65 : 66;
    case 5: case 30: return 64;
    case 8: case 9: case 10: return 3;
    case 0: return 0;
    default: return WORKING.has(dat.ls) ? 1 : 0;
  }
}

module.exports = (api) => api.registerPlatform(PLATFORM_NAME, WorxPlatform);

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
    for (const item of items) {
      seen.add(this.config.mode === 'vacuum' ? await this.addVacuumMower(item) : this.addMower(item));
    }
    for (const [uuid, acc] of this.accessories) {
      if (!seen.has(uuid)) { this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]); this.accessories.delete(uuid); }
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
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
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

  async apiGet(path) {
    const r = await fetch(`https://${this.cloud.api}${path}`, {
      headers: { authorization: `Bearer ${this.session.access_token}`, accept: 'application/json' } });
    let body = null; try { body = await r.json(); } catch { /* not JSON */ }
    return { status: r.status, body };
  }

  // Zones come from the map's zone layers; each has a numeric summary.id, which is what the start command's cut.z list takes.
  async fetchZones() {
    const found = new Map();
    const scan = (v) => {
      if (Array.isArray(v)) return v.forEach(scan);
      if (!v || typeof v !== 'object') return;
      const sum = v.summary;
      const isZone = String(v.type || (sum && sum.type) || '').toLowerCase() === 'zone';
      if (isZone && sum && Number.isInteger(sum.id) && typeof v.name === 'string') found.set(sum.id, v.name);
      Object.values(v).forEach(scan);
    };
    try {
      for (const prefix of ['/api/v2', '/api/v1', '/api/v3', '']) {
        const list = await this.apiGet(`${prefix}/maps`);
        if (list.status !== 200) continue;
        const maps = Array.isArray(list.body) ? list.body : (list.body && (list.body.data || list.body.maps)) || [];
        const map = maps.find((m) => m && m.active) || maps[0];
        if (!map || !map.id) { this.log.warn('No maps found on this account'); return []; }
        for (const sub of ['/layers', '']) {
          const res = await this.apiGet(`${prefix}/maps/${encodeURIComponent(map.id)}${sub}`);
          if (res.status === 200) scan(res.body);
          if (found.size) break;
        }
        break;
      }
    } catch (e) { this.log.warn(`Could not load zones: ${e.message}`); }
    const zones = [...found].map(([id, name]) => ({ id, name }));
    this.log.info(zones.length ? `Zones: ${zones.map((z) => `${z.name} (${z.id})`).join(', ')}` : 'No zones found; area selection disabled');
    return zones;
  }

  async addVacuumMower(item) {
    const matter = this.api.matter;
    if (!matter || !this.api.isMatterEnabled()) {
      this.log.warn('mode "vacuum" needs Homebridge 2+ with Matter enabled; falling back to the HomeKit switch');
      return this.addMower(item);
    }
    const uuid = matter.uuid.generate(`${PLUGIN_NAME}:${item.serial_number}`);
    const d = (item.last_status && item.last_status.payload && item.last_status.payload.dat) || {};
    const batt = (dat) => Math.min(100, Math.max(0, (dat.bt && dat.bt.p) || 0));
    const chargeState = (dat) => (dat.bt && dat.bt.c ? 1 : rvcState(dat) === 66 ? 2 : 3);
    let registered = false;
    const zones = await this.fetchZones();
    const zoneIds = new Set(zones.map((z) => z.id));
    let selected = [];

    const run = async (cmd, runMode, opState, extra) => {
      try { this.command(item, cmd, extra); } catch (e) { throw new matter.status.Failure(e.message); }
      await matter.updateAccessoryState(uuid, 'rvcRunMode', { currentMode: runMode });
      await matter.updateAccessoryState(uuid, 'rvcOperationalState', { operationalState: opState });
    };

    const op0 = rvcState(d);
    const accessory = {
      UUID: uuid,
      displayName: item.name || item.serial_number,
      deviceType: matter.deviceTypes.RoboticVacuumCleaner,
      serialNumber: item.serial_number,
      manufacturer: 'Worx',
      model: (item.product && item.product.code) || 'Landroid',
      clusters: {
        rvcRunMode: {
          supportedModes: [
            { label: 'Idle', mode: 0, modeTags: [{ value: 16384 }] },
            { label: 'Mowing', mode: 1, modeTags: [{ value: 16385 }] },
          ],
          currentMode: op0 === 1 ? 1 : 0,
        },
        rvcOperationalState: {
          phaseList: null, currentPhase: null, countdownTime: null,
          operationalStateList: [0, 1, 2, 3, 64, 65, 66].map((operationalStateId) => ({ operationalStateId })),
          operationalState: op0,
          operationalError: { errorStateId: 0 },
        },
        powerSource: {
          status: 0, order: 0, description: 'Battery',
          batPercentRemaining: batt(d) * 2,
          batChargeLevel: batt(d) <= 10 ? 2 : batt(d) <= 20 ? 1 : 0,
          batPresent: true, batQuantity: 1,
          batChargeState: chargeState(d),
          batFunctionalWhileCharging: true,
          activeBatFaults: [], activeBatChargeFaults: [],
        },
        ...(zones.length ? { serviceArea: {
          supportedMaps: [{ mapId: 1, name: item.name || 'Lawn' }],
          supportedAreas: zones.map((z) => ({
            areaId: z.id, mapId: 1,
            areaInfo: { locationInfo: { locationName: z.name, floorNumber: null, areaType: null }, landmarkInfo: null },
          })),
          selectedAreas: [], currentArea: null, estimatedEndTime: null,
        } } : {}),
      },
      handlers: {
        rvcRunMode: {
          changeToMode: async ({ newMode }) => {
            if (newMode === 1) return run(CMD.START, 1, 1, selected.length ? { cut: { z: selected } } : undefined);
            if (newMode === 0) return run(CMD.HOME, 0, 64);
            throw new matter.status.ConstraintError(`Unsupported mode ${newMode}`);
          },
        },
        rvcOperationalState: {
          pause: () => run(CMD.STOP, 1, 2),
          resume: () => run(CMD.RESUME, 1, 1),
          goHome: () => run(CMD.HOME, 0, 64),
        },
        ...(zones.length ? { serviceArea: {
          selectAreas: async ({ newAreas }) => {
            const bad = newAreas.filter((a) => !zoneIds.has(a));
            if (bad.length) throw new matter.status.ConstraintError(`Unknown zone id ${bad.join(', ')}`);
            selected = [...new Set(newAreas)];
            this.log.info(selected.length ? `Zone selection: ${selected.map((id) => zones.find((z) => z.id === id).name).join(', ')}` : 'Zone selection cleared: whole lawn');
            setImmediate(() => matter.updateAccessoryState(uuid, 'serviceArea', { selectedAreas: [...selected] })
              .catch((e) => this.log.warn(`Could not store zone selection: ${e.message}`)));
          },
        } } : {}),
      },
    };

    const apply = async (payload) => {
      const dat = payload && payload.dat; if (!dat || !registered) return;
      const st = rvcState(dat);
      await matter.updateAccessoryState(uuid, 'rvcRunMode', { currentMode: st === 1 || st === 2 ? 1 : 0 });
      await matter.updateAccessoryState(uuid, 'rvcOperationalState', { operationalState: st });
      await matter.updateAccessoryState(uuid, 'powerSource', {
        batPercentRemaining: batt(dat) * 2,
        batChargeLevel: batt(dat) <= 10 ? 2 : batt(dat) <= 20 ? 1 : 0,
        batChargeState: chargeState(dat),
      });
    };
    this.mowers.set(item.serial_number, { item, apply: (p) => apply(p).catch((e) => this.log.warn(`Matter update failed: ${e.message}`)) });
    await matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    registered = true;
    this.log.info(`Published Matter robot vacuum: ${accessory.displayName} (pair it from the plugin's External Accessories QR code)`);
    return undefined;
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

  command(item, cmd, extra = {}) {
    this.log.info(`${item.name}: cmd ${cmd}${extra.cut ? ` zones ${extra.cut.z}` : ''}`);
    if (!this.client || !this.client.connected) throw this.api.hap ? new this.api.hap.HapStatusError(-70402) : new Error('MQTT not connected');
    this.client.publish(item.mqtt_topics.command_in, JSON.stringify({ cmd, ...extra }), { qos: 1 });
  }
}
