'use strict';
const { driverProbe, unsignedDriverProbe, dllProbe } = require('../platform-probes');
// Output text for Parser.ParseInput only; these probes must not be executed by tests.
process.stdout.write(JSON.stringify([
    driverProbe(['example-test-driver', "quote'test"]),
    unsignedDriverProbe(), dllProbe(12345),
]));
