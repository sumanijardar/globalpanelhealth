const EventEmitter = require('events');

class HealthEventEmitter extends EventEmitter {}

const healthEvents = new HealthEventEmitter();
healthEvents.setMaxListeners(200);

module.exports = healthEvents;
