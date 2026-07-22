"use strict";
const assert=require("assert"),fs=require("fs"),path=require("path");
const roles=require("../../auth/legacyActionRoles");
const {runWhatsappMenuShadow}=require("../whatsappMenuShadow");
const index=fs.readFileSync(path.join(__dirname,"../../../index.js"),"utf8");
const claude=fs.readFileSync(path.join(__dirname,"../../utils/claude.js"),"utf8");

assert(index.includes('action === "debugMenuShadow"'));
assert(index.includes('DYNAMIC_MENU_SHADOW_DEBUG_ENABLED !== "true"'));
assert(/return res\.status\(404\)/.test(index));
assert.equal(roles.isAllowed("admin","debugMenuShadow"),true);
assert.equal(roles.isAllowed("operator","debugMenuShadow"),false);
assert.equal(roles.isAllowed("rider","debugMenuShadow"),false);
const branch=index.slice(index.indexOf('action === "debugMenuShadow"'),index.indexOf('action === "getManualGiros"'));
assert(branch.includes("runWhatsappMenuShadow"));
assert(branch.includes("getCanonicalMenu"));
assert(!/sbInsert|sbUpdate|sbDelete|sbUpsert|creaOrdine|conv|planner|financial/i.test(branch));
assert(claude.includes('code: "LLM_KEY_MISSING"'));
assert(!/userMessage|systemPrompt|apiKey[,:]/.test(claude.slice(claude.indexOf('event: "llm_diagnostic"'),claude.indexOf('const modello'))));

(async()=>{const legacy={matched:false};let emitted=0;const menu={categorias:[],productos:[{id:"p1",nombreCanonico:"Coca Cola",ingredientesBase:[]}],extras:[],aliases:[{alias:"coca",productoId:"p1"}]};const out=await runWhatsappMenuShadow({enabled:true,legacyItems:[],references:[{input:"coca",legacyResult:legacy}],loadCanonicalMenu:async()=>menu,emitDiagnostic:()=>{emitted++}});assert.equal(out.diagnostics[0].classification,"DYNAMIC_EXPANSION");assert.deepStrictEqual(out.legacyItems,[]);assert.deepStrictEqual(legacy,{matched:false});assert.equal(emitted,1);const out2=await runWhatsappMenuShadow({enabled:true,legacyItems:[],references:[{input:"coca",legacyResult:legacy}],loadCanonicalMenu:async()=>menu,emitDiagnostic:()=>{throw Error("sink")}});assert.equal(out2.error,undefined);console.log("menuShadowDebugEntrypoint: ok")})().catch(e=>{console.error(e);process.exit(1)});
