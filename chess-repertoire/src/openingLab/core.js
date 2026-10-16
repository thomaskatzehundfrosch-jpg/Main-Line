import {Chess} from 'chess.js';
export {Chess};
export const START='rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
export const EXAMPLES={italian:'1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 *',evans:'1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4 Bxb4 5. c3 Ba5 *',decision:'1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4 Bxb4 5. c3 Ba5 6. d4 Nf6 *',sicilian:'1. e4 c5 2. d4 cxd4 *',f4:'1. e4 c5 2. d4 cxd4 3. f4 *',quiet:'1. Nf3 Nf6 2. g3 g6 3. Bg2 Bg7 4. O-O O-O *'};
export const uci=m=>m.from+m.to+(m.promotion||'');
export function position(text,format='pgn'){
 if(!text.trim())return {root:START,moves:[]};
 const b=new Chess();if(format==='fen')b.load(text.trim());else b.loadPgn(text.trim());
 const hist=b.history({verbose:true});const root=hist.length?hist[0].before:b.fen();
 return {root,moves:hist.map(uci)};
}
export function board(s){const b=new Chess(s.root);for(const m of s.moves)b.move(m);return b;}
export function advance(s,m){const b=board(s);const result=b.move(m);if(!result)throw Error('Illegal move '+m);return {...s,moves:[...s.moves,uci(result)]};}
export function key(s){return s.root+'|'+s.moves.join(',');}
export function san(s,m){const b=board(s);return b.move(m)?.san||m;}
export function cpLoss(best,value,mover,side){return Math.max(0,(best-value)*(mover===side?1:-1));}
export function passes(cp,best,tolerance,floor,mate=null){return mate!==null?mate>0:cp!==null&&cp>=floor&&best-cp<=tolerance;}
export function metrics(rows,policy,mover,side,threshold,legalCount){
 if(!rows.length||rows.some(r=>r.cp===null))return null;
 const best=(mover===side?Math.max:Math.min)(...rows.map(r=>r.cp));
 const acceptable=rows.filter(r=>cpLoss(best,r.cp,mover,side)<=threshold);
 const mass=policy?Math.min(1,rows.reduce((n,r)=>n+(policy[r.uci]||0),0)):null;
 const safe=policy?Math.min(1,acceptable.reduce((n,r)=>n+(policy[r.uci]||0),0)):null;
 return {acceptableMoves:acceptable.length,analysedMoves:rows.length,legalMoves:legalCount,
  countLowerBound:rows.length<legalCount,safeMass:safe,coveredMass:mass,tailMass:mass===null?null:Math.max(0,1-mass),
  coveredRegretCp:policy?rows.reduce((n,r)=>n+(policy[r.uci]||0)*cpLoss(best,r.cp,mover,side),0):null,thresholdCp:threshold};
}
export function validatePolicy(b,p){const legal=b.moves({verbose:true}).map(uci);if(legal.length!==Object.keys(p).length||legal.some(m=>!Object.hasOwn(p,m)))throw Error('Maia policy does not cover legal moves');const vals=Object.values(p);if(vals.some(x=>!Number.isFinite(x)||x<0||x>1)||Math.abs(vals.reduce((a,b)=>a+b,0)-1)>1e-5)throw Error('Invalid Maia probability mass');return p;}
export function branches(node,settings){
 const rows=node.analysis.rows;if(!rows.length)return [];
 const b=board(node.state),our=b.turn()===settings.side;
 if(our){const best=rows[0];return rows.filter(r=>r.cp!==null&&best.cp!==null&&best.cp-r.cp<=settings.acceptable).slice(0,settings.ourBranches).map(r=>r.uci).concat(best.cp===null?[best.uci]:[]).slice(0,settings.ourBranches);}
 const likely=node.policy?Object.keys(node.policy).sort((a,b)=>node.policy[b]-node.policy[a]).slice(0,settings.opponentBranches):rows.slice(0,settings.opponentBranches).map(r=>r.uci);
 return [...new Set([rows[0].uci,...(node.critical||[]),...likely])];
}
export function* nodes(n){if(n){yield n;for(const ch of Object.values(n.children))yield* nodes(ch);}}
export function summarize(result){
 for(const c of result.candidates){const ns=[...nodes(c.tree)],own=ns.filter(n=>board(n.state).turn()===result.settings.side&&n.metrics),opp=ns.filter(n=>board(n.state).turn()!==result.settings.side&&n.metrics);
  c.components={objectiveCp:c.cp,lossCp:c.loss,ourSafeMin:own.length?Math.min(...own.map(n=>n.metrics.safeMass)):null,opponentSafeMax:opp.length?Math.max(...opp.map(n=>n.metrics.safeMass)):null,ourAcceptableMin:own.length?Math.min(...own.map(n=>n.metrics.acceptableMoves)):null,decisions:ns.length,
   expandedBranches:ns.reduce((n,x)=>n+Object.keys(x.children).length,0),databaseGames:result.database?.games??null,databaseMoveGames:result.database?.move_counts?.[c.uci]??null,earlierReachability:null};
  c.eligible=c.pass&&own.length>0&&opp.length>0&&ns.every(n=>n.metrics&&n.metrics.coveredMass>=0.9)&&Math.max(...ns.map(n=>n.ply))>=result.settings.horizon-1;
 }
 const survivors=result.candidates.filter(c=>c.pass);let ordered=[];
 if(survivors.length&&survivors.every(c=>c.eligible)){
  let pool=[...survivors],layer=1;const vec=c=>[-c.loss,c.components.ourSafeMin,-c.components.opponentSafeMax,c.components.ourAcceptableMin];
  while(pool.length){const front=pool.filter(c=>!pool.some(o=>o!==c&&vec(o).every((x,i)=>x>=vec(c)[i])&&vec(o).some((x,i)=>x>vec(c)[i])));front.sort((a,b)=>a.loss-b.loss);for(const c of front)c.layer=layer;ordered.push(...front);pool=pool.filter(c=>!front.includes(c));layer++;}
  result.ranking='Pareto layers: objective loss, our safe mass, opponent safe mass, own alternatives. Within a layer: objective loss. These are diagnostic proxies.';
 }else{ordered=survivors.sort((a,b)=>a.loss-b.loss);result.ranking='Objective ordering only: multi-ply coverage is insufficient for practical ranking.';}
 ordered.forEach((c,i)=>c.rank=i+1);return result;
}
const esc=s=>String(s).replace(/[\[\]{}]/g,'').replace(/"/g,"'");
export function exportPgn(result){
 let text='[Annotator "Opening Lab; utility is not a win probability"]\n[Event "Opening Lab browser analysis"]\n[Result "*"]\n';
 if(result.input.root!==START)text+='[SetUp "1"]\n[FEN "'+result.input.root+'"]\n';
 let history=new Chess(result.input.root),prefix='';for(const m of result.input.moves){prefix+=notation(history,m)+' ';history.move(m);}
 function choices(n){if(!n)return [];const keys=[...new Set([...(result.prepared||[]).filter(e=>e.id===key(n.state)).map(e=>e.move),...(n.critical||[]),...(n.analysis.rows[0]?[n.analysis.rows[0].uci]:[]),...Object.keys(n.children),...(n.policy?Object.keys(n.policy).sort((a,b)=>n.policy[b]-n.policy[a]).slice(0,3):[])])];
  return keys.map(u=>{const row=n.analysis.rows.find(r=>r.uci===u);return {uci:u,node:n.children[u],pv:row?.pv?.slice(1)||[],comment:`Maia p=${n.policy?.[u]??'missing'}; Lichess games=${n.database?.move_counts?.[u]??'unknown'}; Prepared=${result.prepared?.some(e=>e.id===key(n.state)&&e.move===u)?'accepted':'no'}; Stockfish cp=${row?.cp??'unscored'}; ${row?.mate!=null?'mate='+row.mate:''}`};});
 }
 function parts(state,item){const after=advance(state,item.uci),head=notation(board(state),item.uci)+(item.comment?' {'+esc(item.comment)+'}':'');let tail='';
  if(item.node)tail=render(after,choices(item.node));
  else{let s=after;for(const u of item.pv||[]){tail+=(tail?' ':'')+notation(board(s),u);s=advance(s,u);}}
  return {head,tail};
 }
 function render(state,list){if(!list.length)return '';const first=parts(state,list[0]);
  // PGN alternatives replace the immediately preceding move. Insert them
  // after that move, before its continuation, rather than after a long PV.
  const alternatives=list.slice(1).map(item=>{const p=parts(state,item);return ' ('+p.head+(p.tail?' '+p.tail:'')+')';}).join('');
  return first.head+alternatives+(first.tail?' '+first.tail:'');
 }
 const top=result.mode==='diagnostic'?choices(result.tree):[...result.candidates].sort((a,b)=>(a.rank||999)-(b.rank||999)).map(c=>({uci:c.uci,node:c.tree,pv:c.bestDefence?.pv||[],comment:`Filter ${c.pass}; cp=${c.cp}; mate=${c.mate}; loss=${c.loss}; ${result.settings.side} perspective`}));
 return text+'\n'+prefix+render(result.input,top)+' *\n';
}
function notation(b,u){const n=b.fen().split(' ')[5],turn=b.turn();return n+(turn==='w'?'. ':'... ')+new Chess(b.fen()).move(u).san;}
