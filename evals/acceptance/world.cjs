'use strict';
// SYNTHETIC TEST DATA. Not specifications of products sold by BAKAUT.
const {hash}=require('./engine.cjs');
const rows=[
 ['G3','generator',3,28,48000,'petrol',220,false,false,false],
 ['G5','generator',5,70,85000,'petrol',220,true,false,false],
 ['G5R','generator',5,72,89000,'petrol',220,true,false,true],
 ['G5A','generator',5,78,115000,'petrol',220,true,true,false],
 ['G6','generator',6,86,98000,'petrol',220,true,false,false],
 ['G8D','generator',8,155,240000,'diesel',380,true,false,false],
 ['P60','plate',null,60,42000,'petrol',null,null,null,null],
 ['P85','plate',null,85,65000,'petrol',null,null,null,null],
 ['P110','plate',null,110,79000,'petrol',null,null,null,null],
 ['P160','plate',null,160,125000,'diesel',null,null,null,null],
 ['R65','rammer',null,65,85000,'petrol',null,null,null,null],
 ['C350','cutter',null,85,97000,'petrol',null,null,null,null],
 ['MAT85','plateAccessory',null,5,4800,null,null,null,null,null]
];
const nouns={generator:'Генератор',plate:'Виброплита',rammer:'Вибротрамбовка',cutter:'Швонарезчик',plateAccessory:'Коврик для виброплиты'};
function makeWorld() {
 const products=rows.map(([key,cls,nominalKw,weightKg,price,fuel,voltage,electricStart,autoStart,remoteStart],index)=>({
  key,id:`00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,name:`${nouns[cls]} BAKAUT-TEST ${key}`,
  class:cls,nominalKw,weightKg,price,fuel,voltage,electricStart,autoStart,remoteStart,
  currency:'RUB',sourceUrl:`https://fixtures.bakaut.invalid/product/${key}`,
  specs:{'Масса':`${weightKg} кг`,...(nominalKw?{'Номинальная мощность':`${nominalKw} кВт`,'Максимальная мощность':`${nominalKw+0.5} кВт`}:{}),...(voltage?{'Напряжение':`${voltage} В`}:{}),...(fuel?{'Тип топлива':fuel==='petrol'?'Бензин':'Дизель'}:{}),...(electricStart!==null?{'Электростартер':electricStart?'Да':'Нет','Автоматический запуск АВР':autoStart?'Да':'Нет','Запуск с брелока':remoteStart?'Да':'Нет'}:{})}
 }));
 return {version:2,label:'SYNTHETIC — isolated test database only',products,sources:[...products.map(p=>({id:`catalog:${p.key}`,productKey:p.key,url:p.sourceUrl,title:p.name,text:JSON.stringify({price:p.price,specs:p.specs})})),
 {id:'manual:G5',productKey:'G5',url:'https://fixtures.bakaut.invalid/manual/G5',title:'BAKAUT-TEST G5 — test manual',text:'Тестовая модель BAKAUT-TEST G5: номинальная мощность 5 кВт, максимальная 5,5 кВт. Масса 70 кг. Электростартер имеется. Автоматический запуск АВР отсутствует. Дистанционного запуска с брелока нет.'},
 {id:'manual:P85',productKey:'P85',url:'https://fixtures.bakaut.invalid/manual/P85',title:'BAKAUT-TEST P85 — test manual',text:'Тестовая виброплита BAKAUT-TEST P85 имеет массу 85 кг. Тестовый коврик MAT85 совместим только с подошвой тестовой модели P85. Не переносить совместимость на P60 и P110.'}
 ]};
}
function render(text,world) {
 let source=String(text),out='';
 while(source.includes('{{')) {const start=source.indexOf('{{'),end=source.indexOf('}}',start+2);if(end<0)throw new Error('UNCLOSED_TEMPLATE');out+=source.slice(0,start);const [key,field,...extra]=source.slice(start+2,end).split('.');const p=world.products.find(p=>p.key===key);if(!p||extra.length||!['name','id','price'].includes(field))throw new Error('UNKNOWN_TEMPLATE_REFERENCE');out+=String(p[field]);source=source.slice(end+2);}
 return out+source;
}
function materializeScenario(s,world) {return {...s,steps:s.steps.map(st=>({...st,user:render(st.user,world),criteria:st.criteria.map(c=>({...c,rule:render(c.rule,world)}))}))};}
module.exports={makeWorld,render,materializeScenario};
