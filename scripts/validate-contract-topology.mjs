#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { validateContractTopology } from '../src/contract-topology.mjs';

const path = process.argv[2] ?? 'config/contract-topology.json';
const topology = JSON.parse(readFileSync(path, 'utf8'));
const result = validateContractTopology(topology);
console.log(
  `contract-topology: ${result.applications} application(s), ` +
  `${result.specifications} specification(s), ${result.relationships} relationship(s), ` +
  `first environment=${result.environment}`,
);
