import React,{useEffect,useState} from 'react';
import type {buildDialogueQualityAudit} from '../ai/dialogueQualityAudit';
type Report=ReturnType<typeof buildDialogueQualityAudit>;

export function OutcomeDashboard({baseUrl,token}:{baseUrl:string;token:string}) {
  const [report,setReport]=useState<Report|null>(null);
  const [error,setError]=useState('');
  const [refresh,setRefresh]=useState(0);
  const [loading,setLoading]=useState(false);
  useEffect(()=>{
    setReport(null);setError('');
    if(!token)return;
    const controller=new AbortController();setLoading(true);
    fetch(`${baseUrl}/api/admin/quality/audit?hours=24&limit=1000`,{
      headers:{Authorization:`Bearer ${token}`},signal:controller.signal
    }).then(async response=>{
      if(response.status===403)throw new Error('Для метрик нужен диагностический доступ.');
      if(!response.ok)throw new Error('Не удалось загрузить метрики.');
      return response.json() as Promise<Report>;
    }).then(data=>{if(!controller.signal.aborted)setReport(data);}).catch(cause=>{
      if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:'Ошибка загрузки');
    }).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>controller.abort();
  },[baseUrl,token,refresh]);
  if(!token)return null;
  const number=(value:number|null|undefined,suffix='')=>value==null?'Нет данных':`${value.toLocaleString('ru-RU',{maximumFractionDigits:4})}${suffix}`;
  return <details className="outcome-dashboard">
    <summary>Результат консультаций за последние 24 часа</summary>
    <button type="button" disabled={loading} onClick={()=>setRefresh(value=>value+1)}>{loading?'Загрузка…':'Обновить метрики'}</button>
    {error?<p role="status">{error}</p>:null}
    {report?<>
      <p>Ходов: {report.turnCount}. Подтверждённо решено: {report.cost.resolvedConversationCount}; не решено: {report.cost.unresolvedConversationCount}; без оценки: {report.cost.unknownConversationCount}.</p>
      <table><caption>Измеренные показатели и пробелы в данных</caption><tbody>
        <tr><th scope="row">Расход на решённое обращение</th><td>{number(report.cost.costPerResolvedConversationUsd,' USD')}</td></tr>
        <tr><th scope="row">Ходы с неизвестным расходом</th><td>{report.cost.unknownCostTurnCount}</td></tr>
        <tr><th scope="row">Подготовка ответа сервером, p95</th><td>{number(report.operations.serverAnswerLatency.p95Ms,' мс')}</td></tr>
        <tr><th scope="row">Первый полезный текст в видимом виджете, p95</th><td>{number(report.operations.firstUsefulContentMs.p95Ms,' мс')}; измерено {report.operations.firstUsefulContentMs.sampleCount} из {report.operations.firstUsefulContentMs.turnDenominator} ходов</td></tr>
        <tr><th scope="row">Попытки восстановления</th><td>{number(report.operations.recoveryAttempts.total)}</td></tr>
        <tr><th scope="row">Восстановленные ответы</th><td>{report.operations.recoveredTurns} из {report.operations.turnDenominator} ходов</td></tr>
        <tr><th scope="row">Остановки дополнительной проверки</th><td>{number(report.operations.autonomy.stoppedTurnCount)}; наблюдалось {report.operations.autonomy.observedTurnCount} из {report.operations.autonomy.turnDenominator} ходов</td></tr>
        <tr><th scope="row">Достигнут предел циклов проверки</th><td>{number(report.operations.autonomy.roundLimitTurnCount)}; это сигнал для разбора, не оценка ответа</td></tr>
        <tr><th scope="row">Причины остановки проверки</th><td>{report.operations.autonomy.stopReasons.map(item=>`${item.reason}: ${item.turnCount}`).join('; ') || 'Нет записей об остановках'}</td></tr>
        <tr><th scope="row">Использование сохранённых знаний</th><td>{number(report.operations.knowledgeReuse.total)}; измерено ходов: {report.operations.knowledgeReuse.sampleCount}</td></tr>
        <tr><th scope="row">Наблюдаемые дубли отправок</th><td>{number(report.operations.duplicateBusinessActions?.observedDuplicateOperations)}; операций: {number(report.operations.duplicateBusinessActions?.operationDenominator)}; неизвестный исход: {number(report.operations.duplicateBusinessActions?.unknownOperations)}</td></tr>
        <tr><th scope="row">Дубли на 100 операций с полным наблюдением</th><td>{number(report.operations.duplicateBusinessActions?.duplicatesPer100Operations)}</td></tr>
        <tr><th scope="row">Повторные попытки отправки</th><td>{number(report.operations.duplicateBusinessActions?.retryCount)} из {number(report.operations.duplicateBusinessActions?.attemptCount)} попыток</td></tr>
      </tbody></table>
      <p>Расход рассчитан по данным использования и тарифам; это не счёт провайдера. Полученный ответ сам по себе не подтверждает решение вопроса. Время первого текста сообщает браузер при первоначальной отправке; восстановление после перезагрузки в эту выборку не входит.{report.possiblyTruncated?' Выборка ограничена; агрегаты неполные.':''}</p>
    </>:null}
  </details>;
}
