// Entity-resolution pairs: are these the same legal entity? SYNTHETIC (see types.ts).
import type { EntityPair } from './types.ts'

export const PAIRS: readonly EntityPair[] = [
  // name_variant: suffix / punctuation / case only
  { id: 'P01', kind: 'name_variant', a: { name: 'Alder Ridge Constructions Pty Ltd' }, b: { name: 'ALDER RIDGE CONSTRUCTIONS' }, same: true, labelBasis: 'Same ABN 11000000001 (synthetic ABR): upper-case rendering of one registered name' },
  { id: 'P02', kind: 'name_variant', a: { name: 'Bluegum Interiors Pty. Ltd.' }, b: { name: 'Bluegum Interiors Pty Ltd' }, same: true, labelBasis: "Same ABN 11000000002: punctuation difference in 'Pty. Ltd.'" },
  { id: 'P03', kind: 'name_variant', a: { name: 'Cobalt Civil & Building Pty Ltd' }, b: { name: 'Cobalt Civil & Building' }, same: true, labelBasis: 'Same ABN 11000000003: trading name omits the entity suffix' },
  { id: 'P04', kind: 'name_variant', a: { name: 'Kestrel Constructions Pty Ltd' }, b: { name: 'Kestrel  Constructions Pty Ltd' }, same: true, labelBasis: 'Same ABN 11000000026: whitespace difference only' },
  { id: 'P05', kind: 'name_variant', a: { name: 'Tidewater Builders' }, b: { name: 'Tidewater Builders Pty Ltd' }, same: true, labelBasis: 'Same ABN 11000000024: suffix omitted' },
  // bracket_variant: state/country tokens in brackets
  { id: 'P06', kind: 'bracket_variant', a: { name: 'Hartley Group Construction (Qld) Pty Ltd' }, b: { name: 'Hartley Group Construction Pty Ltd' }, same: true, labelBasis: "Same ABN 11000000022: ABR lists '(Qld)' as part of the registered name of that one entity" },
  { id: 'P07', kind: 'bracket_variant', a: { name: 'Brightwater Builders (Aust) Pty Ltd' }, b: { name: 'Brightwater Builders' }, same: true, labelBasis: "Same ABN 11000000021: ABR lists '(Aust)' as part of the registered name of that one entity" },
  { id: 'P08', kind: 'bracket_variant', a: { name: 'Summit Build (QLD)' }, b: { name: 'Summit Build Pty Ltd' }, same: true, labelBasis: "Same ABN 11000000023: ABR lists '(QLD)' as a business name of that one entity" },
  // abbreviation: and / & and initials
  { id: 'P09', kind: 'abbreviation', a: { name: 'Marlow & Sons Building Pty Ltd' }, b: { name: 'Marlow and Sons Building Pty Ltd' }, same: true, labelBasis: "Same ABN 11000000004: '&' and 'and' are both used for one registered name" },
  { id: 'P10', kind: 'abbreviation', a: { name: 'J & K Contracting Pty Ltd' }, b: { name: 'J and K Contracting' }, same: true, labelBasis: "Same ABN 11000000071: '&' and 'and' both used for one registered name" },
  { id: 'P11', kind: 'abbreviation', a: { name: 'Coolflow Mechanical Pty Ltd' }, b: { name: 'Coolflow Mech Pty Ltd' }, same: true, labelBasis: "Same ABN 11000000051: 'Mech' is a registered business-name abbreviation of that entity" },
  // abn_trading_name: different names, same ABN (one side may omit the ABN)
  { id: 'P12', kind: 'abn_trading_name', a: { name: 'Voltaic Services Pty Ltd', abn: '11000000005' }, b: { name: 'Volt Electrical', abn: '11000000005' }, same: true, labelBasis: "Both sides carry ABN 11000000005: 'Volt Electrical' is its registered trading name" },
  { id: 'P13', kind: 'abn_trading_name', a: { name: 'Northline Property Group', abn: '11000000041' }, b: { name: 'Northline Developments', abn: '11000000041' }, same: true, labelBasis: 'Both sides carry ABN 11000000041: two names, one registration' },
  { id: 'P14', kind: 'abn_trading_name', a: { name: 'Skyline Roofing Pty Ltd', abn: '11000000006' }, b: { name: 'Skyline Roofing and Restoration' }, same: true, labelBasis: "ABR lists 'Skyline Roofing and Restoration' as a trading name of ABN 11000000006 (the second record omits the ABN)" },
  // distinct_similar: similar names, different entities
  { id: 'P15', kind: 'distinct_similar', a: { name: 'Alder Ridge Electrical Pty Ltd' }, b: { name: 'Alder Ridge Plumbing Pty Ltd' }, same: false, labelBasis: 'Different ABNs 11000000081 and 11000000082: separate companies in one group' },
  { id: 'P16', kind: 'distinct_similar', a: { name: 'Hartley Group Construction Pty Ltd' }, b: { name: 'Hartley Group Civil Pty Ltd' }, same: false, labelBasis: 'Different ABNs 11000000022 and 11000000083: separate companies' },
  { id: 'P17', kind: 'distinct_similar', a: { name: 'Marlow & Sons Building Pty Ltd', abn: '11000000004' }, b: { name: 'Marlow & Sons Constructions Pty Ltd', abn: '11000000031' }, same: false, labelBasis: 'Different ABNs given on the records (11000000004, 11000000031)' },
  // same_name_different_abn: identical name, different ABN
  { id: 'P18', kind: 'same_name_different_abn', a: { name: 'Summit Build Pty Ltd', abn: '11000000023' }, b: { name: 'Summit Build Pty Ltd', abn: '11000000061' }, same: false, labelBasis: 'Different ABNs given on the records (11000000023, 11000000061): unrelated entities sharing a name' },
  { id: 'P19', kind: 'same_name_different_abn', a: { name: 'Greenfield Landscapes Pty Ltd', abn: '11000000062' }, b: { name: 'Greenfield Landscapes Pty Ltd', abn: '11000000063' }, same: false, labelBasis: 'Different ABNs given on the records (11000000062, 11000000063)' },
  { id: 'P20', kind: 'same_name_different_abn', a: { name: 'Redgum Constructions', abn: '11000000064' }, b: { name: 'Redgum Constructions Pty Ltd', abn: '11000000065' }, same: false, labelBasis: 'Different ABNs given on the records (11000000064, 11000000065)' },
]
