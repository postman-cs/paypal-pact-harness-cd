// Validate and normalize the application/specification relationship graph.
// Relationships are explicit edges, so the same model covers one-to-one,
// one-to-many, many-to-one, and many-to-many estates without changing the gate.

export function validateContractTopology(topology) {
  if (topology?.schemaVersion !== 1) throw new Error('contract topology schemaVersion must be 1');
  const applications = topology.applications ?? [];
  const specifications = topology.specifications ?? [];
  const relationships = topology.relationships ?? [];
  const appIds = new Set();
  const specIds = new Set();

  for (const app of applications) {
    if (!app?.id || appIds.has(app.id)) throw new Error(`application id is missing or duplicated: ${app?.id ?? ''}`);
    appIds.add(app.id);
    if (app.kind && !['provider', 'consumer', 'gateway'].includes(app.kind)) {
      throw new Error(`application kind is invalid: ${app.kind}`);
    }
    for (const source of app.inventorySources ?? []) {
      if (!source?.kind || !source?.url) throw new Error(`application inventory source is incomplete: ${app.id}`);
    }
  }
  for (const spec of specifications) {
    if (!spec?.id || specIds.has(spec.id)) throw new Error(`specification id is missing or duplicated: ${spec?.id ?? ''}`);
    specIds.add(spec.id);
    if (spec.sha256 && !/^[a-f0-9]{64}$/.test(spec.sha256)) {
      throw new Error(`specification sha256 is invalid: ${spec.id}`);
    }
  }

  const edgeKeys = new Set();
  const relationshipIds = new Set();
  for (const edge of relationships) {
    if (!appIds.has(edge?.application)) {
      throw new Error(`relationship references unknown application: ${edge?.application ?? ''}`);
    }
    if (!specIds.has(edge?.specification)) {
      throw new Error(`relationship references unknown specification: ${edge?.specification ?? ''}`);
    }
    const key = `${edge.application}\u0000${edge.specification}`;
    if (edgeKeys.has(key)) throw new Error(`duplicate relationship: ${edge.application} -> ${edge.specification}`);
    edgeKeys.add(key);
    if (edge.id) {
      if (relationshipIds.has(edge.id)) throw new Error(`duplicate relationship id: ${edge.id}`);
      relationshipIds.add(edge.id);
    }
    if (edge.mismatchPolicy && !['block', 'warn'].includes(edge.mismatchPolicy)) {
      throw new Error(`relationship mismatch policy is invalid: ${edge.mismatchPolicy}`);
    }
  }

  const specsByApplication = Object.fromEntries([...appIds].sort().map((id) => [id, []]));
  const applicationsBySpec = Object.fromEntries([...specIds].sort().map((id) => [id, []]));
  for (const edge of relationships) {
    specsByApplication[edge.application].push(edge.specification);
    applicationsBySpec[edge.specification].push(edge.application);
  }
  for (const values of Object.values(specsByApplication)) values.sort();
  for (const values of Object.values(applicationsBySpec)) values.sort();

  return {
    environment: topology.environment ?? 'lower',
    applications: applications.length,
    specifications: specifications.length,
    relationships: relationships.length,
    specsByApplication,
    applicationsBySpec,
  };
}
