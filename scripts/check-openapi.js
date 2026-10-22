#!/usr/bin/env node
'use strict';

const fs = require('fs');
const contract = require('../tests/api/contract/operations.json').operations;
const spec = fs.readFileSync('docs/openapi.yaml', 'utf8');
if (!/^openapi:\s*3\./m.test(spec) || !/^paths:/m.test(spec))
  throw new Error('docs/openapi.yaml is not an OpenAPI 3 document');
if (contract.length < 100) throw new Error('compiled operation contract is unexpectedly small');
console.log(`openapi: ${contract.length} operations in frozen contract`);
