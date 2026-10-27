const db=require('better-sqlite3')('data/tdr.sqlite3',{readonly:true});
console.log('=== ai_models ===');
try{db.prepare('SELECT id,title,adapter,model_ident,data_class FROM ai_models').all().forEach(r=>console.log(' ',JSON.stringify(r)));}catch(e){console.log('ERR:',e.message);}
console.log('=== ai_binding_versions (active) ===');
try{db.prepare("SELECT purpose,version,primary_model_id,fallback_model_id,status FROM ai_binding_versions WHERE status='active' ORDER BY purpose").all().forEach(r=>console.log(' ',JSON.stringify(r)));}catch(e){console.log('ERR:',e.message);}
console.log('=== prompt_versions (active) ===');
try{const r=db.prepare("SELECT prompt_key,version FROM prompt_versions WHERE status='active' ORDER BY prompt_key").all(); console.log('count:',r.length); r.forEach(x=>console.log(' ',x.prompt_key,'v'+x.version));}catch(e){console.log('ERR:',e.message);}
console.log('=== care_assignments ===');
try{db.prepare('SELECT ca.patient_id,ca.clinician_id,p.full_name as pat, u.full_name as clin, u.role FROM care_assignments ca JOIN users p ON p.id=ca.patient_id JOIN users u ON u.id=ca.clinician_id').all().forEach(r=>console.log(' ',JSON.stringify(r)));}catch(e){console.log('ERR:',e.message);}
console.log('=== users ===');
db.prepare('SELECT id,email,role,full_name FROM users ORDER BY role').all().forEach(r=>console.log(' ',JSON.stringify(r)));
db.close();
