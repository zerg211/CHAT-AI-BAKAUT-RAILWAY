const fs = require('fs');
const s = fs.readFileSync('sql/019_electric_start_knowledge.sql', 'utf8');

const insCount = (s.match(/INSERT INTO verified_product_facts/g) || []).length;
const confCount = (s.match(/ON CONFLICT/g) || []).length;

// Extract (product_key, source_url) pairs from VALUES lines
const tuples = new Set();
let dupes = 0;
const re = /VALUES \('[0-9a-f-]+', '([^']+)',.*?'web',\s*'([^']+)'/g;
let m;
while ((m = re.exec(s))) {
  const t = m[1] + '|' + m[2];
  if (tuples.has(t)) {
    dupes++;
    console.log('DUPE:', t);
  }
  tuples.add(t);
}

console.log('inserts:', insCount, '| on-conflict:', confCount, '| unique key|url tuples:', tuples.size, '| dupes:', dupes);

// sanity: every ON CONFLICT clause matches the index definition
const badConflict = /ON CONFLICT (?!\(product_key, attribute, value, source_type, coalesce\(source_url, ''\)\) WHERE status = 'active' DO NOTHING)/g.test(s.replace(/ON CONFLICT \(product_key, attribute, value, source_type, coalesce\(source_url, ''\)\) WHERE status = 'active' DO NOTHING/g, ''));
console.log('conflict clauses consistent:', !badConflict);
