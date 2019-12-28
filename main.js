/**
 *      Admin backend
 *
 *      Controls Adapter-Processes
 *
 *      Copyright 2014-2019 bluefox <dogafox@gmail.com>,
 *      MIT License
 *
 */

/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */
'use strict';

const adapterName = require('./package.json').name.split('.').pop();
const utils       = require('@iobroker/adapter-core'); // Get common adapter utils
const tools 	  = require(utils.controllerDir + '/lib/tools.js');
const SocketIO    = require('./lib/socket');
const Web         = require('./lib/web');
const semver      = require('semver');

const ONE_HOUR_MS = 3600000;
const ERROR_PERMISSION = 'permissionError';

let socket        = null;
let webServer     = null;

let objects       = {};
let secret        = 'Zgfr56gFe87jJOM'; // Will be generated by first start
let adapter;

function startAdapter(options) {
    options = options || {};
	Object.assign(options, {
	    name:           adapterName, // adapter name
	    dirname:        __dirname,   // say own position
	    logTransporter: true,        // receive the logs
	    systemConfig:   true,
	    install:        callback => typeof callback === 'function' && callback()
	});

    adapter = new utils.Adapter(options);

    adapter.on('objectChange', (id, obj) => {
        if (obj) {
            //console.log('objectChange: ' + id);
            objects[id] = obj;

            if (id === 'system.repositories') {
                writeUpdateInfo(adapter);
            }
        } else {
            //console.log('objectDeleted: ' + id);
            if (objects[id]) {
                delete objects[id];
            }
        }

        // TODO Build in some threshold of messages
        socket && socket.objectChange(id, obj);
    });

    adapter.on('stateChange', (id, state) => {
        socket && socket.stateChange(id, state);
    });

    adapter.on('ready', () => {
        adapter.getForeignObject('system.config', (err, obj) => {
            if (!err && obj) {
                obj.native = obj.native || {};
                if (!obj.native.secret) {
                    require('crypto').randomBytes(24, (ex, buf) => {
                        adapter.config.secret = buf.toString('hex');
                        adapter.extendForeignObject('system.config', {native: {secret: adapter.config.secret}});
                        main(adapter);
                    });
                } else {
                    adapter.config.secret = obj.native.secret;
                    main(adapter);
                }
            } else {
                adapter.config.secret = secret;
                adapter.log.error('Cannot find object system.config');
            }
        });
    });

    adapter.on('message', obj => {
        if (!obj || !obj.message) {
            return false;
        }

        socket && socket.sendCommand(obj);

        return true;
    });

    adapter.on('unload', callback => {
        // unsubscribe all
        socket && socket.unsubscribeAll();

        try {
            adapter.log.info('terminating http' + (adapter.config.secure ? 's' : '') + ' server on port ' + adapter.config.port);
            webServer.close();
            callback();
        } catch (e) {
            callback();
        }
    });

// obj = {message: msg, severity: level, from: this.namespace, ts: (new Date()).getTime()}
    adapter.on('log', obj => socket && socket.sendLog(obj));

    return adapter;
}

function createUpdateInfo(adapter) {
    // create connected object and state
    let updatesNumberObj = objects[adapter.namespace + '.info.updatesNumber'];

    if (!updatesNumberObj || !updatesNumberObj.common || updatesNumberObj.common.type !== 'number') {
        let obj = {
            _id:  'info.updatesNumber',
            type: 'state',
            common: {
                role:  'indicator.updates',
                name:  'Number of adapters to update',
                type:  'number',
                read:  true,
                write: false,
                def:   0
            },
            native: {}
        };

        adapter.setObject(obj._id, obj);
    }

    let updatesListObj = objects[adapter.namespace + '.info.updatesList'];

    if (!updatesListObj || !updatesListObj.common || updatesListObj.common.type !== 'string') {
        let obj = {
            _id:  'info.updatesList',
            type: 'state',
            common: {
                role:  'indicator.updates',
                name:  'List of adapters to update',
                type:  'string',
                read:  true,
                write: false,
                def:   ''
            },
            native: {}
        };

        adapter.setObject(obj._id, obj);
    }

    let newUpdatesObj = objects[adapter.namespace + '.info.newUpdates'];

    if (!newUpdatesObj || !newUpdatesObj.common || newUpdatesObj.common.type !== 'boolean') {
        let obj = {
            _id:  'info.newUpdates',
            type: 'state',
            common: {
                role:  'indicator.updates',
                name:  'Indicator if new adapter updates are available',
                type:  'boolean',
                read:  true,
                write: false,
                def:   false
            },
            native: {}
        };

        adapter.setObject(obj._id, obj);
    }

    let updatesJsonObj = objects[adapter.namespace + '.info.updatesJson'];

    if (!updatesJsonObj || !updatesJsonObj.common || updatesJsonObj.common.type !== 'string') {
        let obj = {
            _id:  'info.updatesJson',
            type: 'state',
            common: {
                role:  'indicator.updates',
                name:  'JSON string with adapter update information',
                type:  'string',
                read:  true,
                write: false,
                def:   '{}'
            },
            native: {}
        };

        adapter.setObject(obj._id, obj);
    }

    let lastUpdateCheckObj = objects[adapter.namespace + '.info.lastUpdateCheck'];

    if (!lastUpdateCheckObj || !lastUpdateCheckObj.common || lastUpdateCheckObj.common.type !== 'string') {
        let obj = {
            _id:  'info.lastUpdateCheck',
            type: 'state',
            common: {
                role:  'value.datetime',
                name:  'Timestamp of last update check',
                type:  'string',
                read:  true,
                write: false,
                def:   '{}'
            },
            native: {}
        };

        adapter.setObject(obj._id, obj);
    }
}

// Helper methods
function upToDate(v1, v2) {
	return semver.gt(v2, v1);
}

function writeUpdateInfo(adapter, sources) {
    if (!sources) {
        let obj = objects['system.repositories'];
        if (!objects['system.config'] || !objects['system.config'].common) {
            adapter.log.warn('Repository cannot be read. Invalid "system.config" object.');
            return;
        }

        const activeRepo = objects['system.config'].common.activeRepo;

        if (obj && obj.native && obj.native.repositories && obj.native.repositories[activeRepo] &&
            obj.native.repositories[activeRepo].json) {
            sources = obj.native.repositories[activeRepo].json;
        } else {
            adapter.setState('info.updatesNumber', 0, true);
            adapter.setState('info.updatesList',  '', true);
            adapter.setState('info.newUpdates', false, true);
            adapter.setState('info.updatesJson', '{}', true);
            let updateTime = new Date();
            adapter.setState('info.lastUpdateCheck', new Date(updateTime - updateTime.getTimezoneOffset() * 60000).toISOString(), true);
            if (obj && obj.native && obj.native.repositories && obj.native.repositories[activeRepo]) {
                adapter.log.warn('Repository cannot be read');
            } else {
                adapter.log.warn('No repository source configured');
            }
            return;
        }
    }

    let installed = tools.getInstalledInfo();
    let list  = [];
    let updatesJson = {};
    let newUpdateIndicator = false;
    adapter.getState('info.updatesJson', (err, state) => {
        let oldUpdates;
        if (state && state.val) oldUpdates = JSON.parse(state.val) || {};
        else oldUpdates = {};
        for (let name in sources) {
            if (!sources.hasOwnProperty(name)) continue;
            if (installed[name] && installed[name].version && sources[name].version) {
                if (sources[name].version !== installed[name].version &&
                    !upToDate(sources[name].version, installed[name].version)) {
                    // Check if updates are new or already known to user
                    if (!oldUpdates || !oldUpdates[name] || oldUpdates[name].availableVersion !== sources[name].version) {
                        newUpdateIndicator = true;
                    } // endIf
                    updatesJson[name] = {
                        availableVersion: sources[name].version,
                        installedVersion: installed[name].version
                    };
                    // remove first part of the name
                    const n = name.indexOf('.');
                    list.push(n === -1 ? name : name.substring(n + 1));
                }
            }
        }
        adapter.setState('info.updatesNumber', list.length, true);
        adapter.setState('info.updatesList', list.join(', '), true);
        adapter.setState('info.newUpdates', newUpdateIndicator, true);
        adapter.setState('info.updatesJson', JSON.stringify(updatesJson), true);
        let updateTime = new Date();
        adapter.setState('info.lastUpdateCheck', new Date(updateTime - updateTime.getTimezoneOffset() * 60000).toISOString(), true);
    });
}

function initSocket(server, store, adapter) {
    socket = new SocketIO(server, adapter.config, adapter, objects, store);
    socket.subscribe(null, 'objectChange', '*');
}

function processTasks(adapter) {
    if (!adapter._running && adapter._tasks.length) {
        adapter._running = true;

        const obj = adapter._tasks.shift();
        if (!obj.acl || obj.acl.owner !== adapter.config.defaultUser) {
            obj.acl.owner = adapter.config.defaultUser;
            adapter.setForeignObject(obj._id, obj, err => setImmediate(() => {
                adapter._running = false;
                processTasks(adapter);
            }));
        } else {
            setImmediate(() => {
                adapter._running = false;
                processTasks(adapter);
            });
        }
    }
}

function applyRightsToObjects(adapter, pattern, types, cb) {
    if (typeof types === 'object') {
        let count = types.length;
        types.forEach(type => applyRightsToObjects(adapter, pattern, type, () => !--count && cb && cb()));
    } else {
        adapter.getObjectView('system', types, {startkey: pattern + '.', endkey: pattern + '.\u9999'}, (err, doc) => {
            adapter._tasks = adapter._tasks || [];

            if (!err && doc.rows.length) {
                for (let i = 0; i < doc.rows.length; i++) {
                    adapter._tasks.push(doc.rows[i].value);
                }
                processTasks(adapter);
            }
        });
    }
}

function applyRights(adapter) {
    const promises = [];
    adapter.config.accessAllowedConfigs = adapter.config.accessAllowedConfigs || [];
    adapter.config.accessAllowedTabs    = adapter.config.accessAllowedTabs || [];

    adapter.config.accessAllowedConfigs.forEach(id => promises.push(new Promise(resolve =>
        adapter.getForeignObject('system.adapter.' + id, (err, obj) => {
            if (obj && obj.acl && obj.acl.owner !== adapter.config.defaultUser) {
                obj.acl.owner = adapter.config.defaultUser;
                adapter.setForeignObject('system.adapter.' + id, obj, err => resolve(!err));
            } else {
                resolve(false);
            }
        }))));

    adapter.config.accessAllowedTabs.forEach(id => {
        if (id.startsWith('devices.')) {
            // change rights of all alias.*
            applyRightsToObjects(adapter, 'alias', ['state', 'channel']);
        } else if (id.startsWith('javascript.')) {
            // change rights of all script.js.*
            applyRightsToObjects(adapter, 'javascript', ['script', 'channel']);
        } else if (id.startsWith('fullcalendar.')) {
            // change rights of all fullcalendar.*
            applyRightsToObjects(adapter, 'fullcalendar', ['schedule']);
        } else if (id.startsWith('scenes.')) {
            // change rights of all scenes.*
            applyRightsToObjects(adapter, 'scenes', ['state', 'channel']);
        }
    });

    Promise.all(promises)
        .then(results => {
            const len = results.filter(r => !!r).length;
            len && adapter.log.info(`Updated ${len} objects`);
        });
}

function main(adapter) {
    // adapter.subscribeForeignStates('*');
    // adapter.subscribeForeignObjects('*');

    adapter.config.defaultUser = adapter.config.defaultUser || 'admin';
    if (!adapter.config.defaultUser.match(/^system\.user\./)) {
        adapter.config.defaultUser = 'system.user.' + adapter.config.defaultUser;
    }

    if (adapter.config.secure) {
        // Load certificates
        adapter.getCertificates((err, certificates, leConfig) => {
            adapter.config.certificates = certificates;
            adapter.config.leConfig     = leConfig;

            getData(adapter, adapter => webServer = new Web(adapter.config, adapter, initSocket));
        });
    } else {
        getData(adapter, adapter => webServer = new Web(adapter.config, adapter, initSocket));
    }

    if (adapter.config.accessApplyRights && adapter.config.accessLimit && !adapter.config.auth && adapter.config.defaultUser !== 'system.user.admin') {
        applyRights(adapter);
    }

    // By default update repository every 24 hours
    if (adapter.config.autoUpdate === undefined || adapter.config.autoUpdate === null) {
        adapter.config.autoUpdate = 24;
    }

    // interval in hours
    adapter.config.autoUpdate = parseInt(adapter.config.autoUpdate, 10) || 0;

    adapter.config.autoUpdate && updateRegister();
}

function getData(adapter, callback) {
    adapter.log.info('requesting all states');
    /*
    tasks++;

    adapter.getForeignStates('*', (err, res) => {
        adapter.log.info('received all states');
        states = res;
        !--tasks && callback && callback();
    });*/

    adapter.log.info('requesting all objects');

    adapter.getObjectList({include_docs: true}, (err, res) => {
        adapter.log.info('received all objects');
        if (res) {
            res = res.rows;
            objects = {};
            let tmpPath = '';
            for (let i = 0; i < res.length; i++) {
                objects[res[i].doc._id] = res[i].doc;
                if (res[i].doc.type === 'instance' && res[i].doc.common && res[i].doc.common.tmpPath) {
                    tmpPath && adapter.log.warn('tmpPath has multiple definitions!!');
                    tmpPath = res[i].doc.common.tmpPath;
                }
            }

            // Some adapters want access on specified tmp directory
            if (tmpPath) {
                adapter.config.tmpPath = tmpPath;
                adapter.config.tmpPathAllow = true;
            }

            createUpdateInfo(adapter);
            writeUpdateInfo(adapter);
        }

        callback && callback(adapter);
    });
}

// read repository information from active repository
function updateRegister(isForce) {
    adapter.getForeignObject('system.config', (err, systemConfig) => {
        err && adapter.log.error('May not read "system.config"');

        if (systemConfig && systemConfig.common) {
            adapter.getForeignObject('system.repositories', (err, repos) => {
                err && adapter.log.error('May not read "system.repositories"');
                // Check if repositories exists
                let exists = false;
                const active = systemConfig.common.activeRepo;

                // if repo is valid and actual
                if (!err &&
                    repos &&
                    repos.native &&
                    repos.native.repositories &&
                    repos.native.repositories[active] &&
                    Date.now() < repos.ts + adapter.config.autoUpdate * ONE_HOUR_MS) {
                    exists = true;
                }

                if (!exists || isForce) {
                    adapter.log.info('Request actual repository...');
                    // request repo from host
                    adapter.sendToHost(adapter.host, 'getRepository', {
                        repo:   active,
                        update: true
                    }, _repository => {
                        if (_repository === ERROR_PERMISSION) {
                            adapter.log.error('May not read "getRepository"');
                        } else {
                            adapter.log.info('Repository received successfully.');

                            socket && socket.repoUpdated();
                        }

                        // start next cycle
                        if (adapter.config.autoUpdate) {
                            adapter.timerRepo && clearInterval(adapter.timerRepo);
                            adapter.log.debug('Next repo update on ' + new Date(Date.now() + adapter.config.autoUpdate * ONE_HOUR_MS + 1).toLocaleString());
                            adapter.timerRepo = setTimeout(() => updateRegister(), adapter.config.autoUpdate * ONE_HOUR_MS + 1);
                        }
                    });
                } else if (adapter.config.autoUpdate) {
                    const interval = repos.ts + adapter.config.autoUpdate * ONE_HOUR_MS - Date.now() + 1;
                    adapter.log.debug('Next repo update on ' + new Date(Date.now() + interval).toLocaleString());
                    adapter.timerRepo && clearInterval(adapter.timerRepo);
                    adapter.timerRepo = setTimeout(() => updateRegister(), interval);
                }
            });
        }
    });
}

// If started as allInOne mode => return function to create instance
if (module && module.parent) {
    module.exports = startAdapter;
} else {
    // or start the instance directly
    startAdapter();
}
