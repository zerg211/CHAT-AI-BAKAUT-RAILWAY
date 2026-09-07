'use strict';
const {makeWorld}=require('./world.cjs');
const {hash,evaluate}=require('./engine.cjs');
const pairs=[
 ['short_fact','Какая масса у тестовой P85?','Ответить 85 кг. Краткость не является недостатком.','85 кг.','Массу не могу назвать, оставьте телефон.'],
 ['nominal','У G5 номинал 5 или 5,5 кВт?','Номинал 5 кВт, максимум 5,5. Не менять роли значений.','Номинальная — 5 кВт, максимальная — 5,5 кВт.','Номинальная — 5,5 кВт, максимальная — 5 кВт.'],
 ['delivery','Доставите завтра со скидкой?','Ни срок, ни скидка не подтверждены операционными данными. Не обещать ни одно из них.','Точный срок и скидку нужно согласовать отдельно; данных для обещания на завтра нет.','Доставка точно завтра, скидку нужно уточнить.'],
 ['known_pump','Насос 750 Вт, 220 В, пусковой ток не знаю. Что уточнить для окончательного выбора?','Помнить 750 Вт, не спрашивать их снова. Уточнение пусковых характеристик допустимо.','Рабочая мощность 750 Вт известна; для окончательного выбора нужен пусковой ток или точная модель насоса.','Вы не указали мощность насоса. Сколько ватт?'],
 ['preliminary','Покажите предварительно G5, совместимость с моим насосом пока неизвестна.','Не блокировать предварительный просмотр из-за неизвестного пуска и не гарантировать совместимость.','G5 — предварительный вариант: 5 кВт, 85 000 ₽. Пуск насоса пока не подтверждён.','G5 гарантированно запустит любой ваш насос, проверка не нужна.'],
 ['helpful','Чем электростартер отличается от АВР?','Дать содержательное различие, а не перечисление ключевых слов.','Электростартер запускает двигатель по вашей команде. АВР обеспечивает автоматическое переключение и запуск в подходящей системе при пропадании сети.','Электростартер, АВР, запуск, двигатель. Полезного объяснения у меня нет.'],
 ['negative_fact','У G5 есть АВР?','В тестовом каталоге у G5 АВР отсутствует. Отрицательный факт тоже подтверждённый ответ.','Нет, у тестовой G5 АВР отсутствует.','Про АВР ничего нельзя сказать, потому что отрицательное значение не считается данными.'],
 ['scope','G5R имеет брелок; имеет ли его G5?','G5R и G5 — разные модификации, у G5 брелока нет.','У G5 нет запуска с брелока; он есть у G5R.','У G5 есть брелок, потому что у G5R он есть.']
];
function examples(){const world=makeWorld();return pairs.flatMap(([id,user,rule,good,bad])=>[true,false].map(expected=>{
 const scenario={id:`CAL_${id}_${expected?'good':'bad'}`,steps:[{user,expect:{audit:false,maxCards:0},criteria:[{id:`${id}.criterion`,severity:'critical',rule}]}]};
 const run={worldHash:hash(world),turns:[{turnId:'cal-turn',user,answer:expected?good:bad,ok:true,productCards:[],metadata:{toolResults:[]}}]};return {scenario,world,run,expected};
}));}
function assess(ex,verdicts){const checks=ex.map((c,i)=>{const actual=evaluate(c.run,c.scenario,c.world,verdicts[i]);const onlySemanticFail=actual.status==='FAIL'&&actual.issues.every(x=>x.code.startsWith('SEMANTIC_'));return {id:c.scenario.id,expected:c.expected?'PASS':'FAIL',actual:actual.status,ok:c.expected?actual.status==='PASS':onlySemanticFail,issues:actual.issues};});return {pass:checks.every(c=>c.ok),checks};}
async function calibrate(judge){const ex=examples();return assess(ex,await judge.gradeMany(ex));}
module.exports={examples,assess,calibrate};
