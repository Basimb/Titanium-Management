// libsignal writes whole SessionEntry objects directly to console, bypassing pino.
// Suppress only its diagnostic dumps; retain operational failures and events.
const SESSION_DUMPS=/^(?:Closing session:|Opening session:|Removing old closed session:|Session already closed(?:\b|:))/;
export function installSessionLogSafety(target=console){
  const originals=new Map();
  for(const method of ['info','warn','log','debug']){
    const original=target[method];if(typeof original!=='function')continue;
    originals.set(method,original);
    target[method]=function(...args){
      if(typeof args[0]==='string' && SESSION_DUMPS.test(args[0]))return;
      return original.apply(this,args);
    };
  }
  return ()=>{for(const [method,original] of originals)target[method]=original;};
}
