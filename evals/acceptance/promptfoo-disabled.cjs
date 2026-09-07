'use strict';
module.exports=class RetiredPromptfooEntry {
 id(){return 'bakaut-legacy-evals-retired';}
 async callApi(){return {error:'Legacy keyword/rubric pipeline has been replaced. Use npm run test:acceptance:offline and npm run test:acceptance:live with explicit approval and budgets. This is NOT a passing evaluation.'};}
};
