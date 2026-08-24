import * as cheerio from "cheerio";
import { SPOOFED_HEADERS, UC_INTL_API_HEADERS, UC_CN_API_HEADERS, extractPasscode, extractShareId, formatBytes, isIntlShareHost } from "@/lib/shared";

export type MediaType = "video" | "file";
export interface FileEntry { name: string; directUrl: string; mediaType: MediaType; size?: string; sizeBytes?: number; isFolder?: boolean; }
export interface ExtractedMedia { directUrl: string; mediaType: MediaType; title?: string; size?: string; resolution?: string; method: string; files?: FileEntry[]; isFolder?: boolean; }
export class ExtractionError extends Error { status: number; constructor(message: string, status = 422) { super(message); this.name = "ExtractionError"; this.status = status; } }
interface UcListItem { fid: string; file_name: string; size?: number; dir?: boolean; file?: boolean; file_type?: number; format_type?: string; share_fid_token?: string; include_items?: number; }
const VIDEO_EXT_LIST=["mp4","m3u8","webm","mkv","mov","m4v","avi","ts","3gp","ogv","flv"];
const EXT_PRIORITY:Record<string,number>={mp4:60,m3u8:55,webm:50,m4v:45,mov:45,mkv:40,mp3:35,ts:30,avi:30,flv:25,ogv:25,"3gp":20};
const MAX_FOLDER_DEPTH=6, MAX_TOTAL_FILES=200, PAGE_SIZE=100;
const UC_INTL_API="https://m-intldrive.ucweb.com/1/clouddrive", UC_CN_API="https://pc-api.uc.cn/1/clouddrive";
function extFromName(n:string){const m=n.match(/\.([a-z0-9]{1,5})$/i);return m?m[1].toLowerCase():null;}
function classify(e:string):MediaType{return VIDEO_EXT_LIST.includes(e)?"video":"file";}
function isDirItem(i:UcListItem){return i.dir===true||i.file===false||i.file_type===0||(i.include_items!=null&&i.include_items>0&&!extFromName(i.file_name||""));}
async function fetchText(url:string,h:Record<string,string>){const r=await fetch(url,{headers:{...h,...SPOOFED_HEADERS},redirect:"follow"});if(!r.ok)throw new ExtractionError(`UC share page HTTP ${r.status}`,r.status===404?404:502);return r.text();}
async function json(url:string,init:RequestInit|undefined,h:Record<string,string>){const c=new AbortController(),t=setTimeout(()=>c.abort(),18000);try{const r=await fetch(url,{...init,headers:{...h,...(init?.headers as Record<string,string>|undefined),Accept:"application/json, text/plain, */*"},signal:c.signal});if(!r.ok)throw new ExtractionError(`UC API HTTP ${r.status}`,r.status===404?404:502);return await r.json() as Record<string,unknown>;}catch(e){if(e instanceof ExtractionError)throw e;if(c.signal.aborted)throw new ExtractionError("UC API timeout",504);throw new ExtractionError("Could not reach UC Drive API",502);}finally{clearTimeout(t);}}
async function discoverStoken(url:URL,intl:boolean){try{const html=await fetchText(url.toString(),intl?UC_INTL_API_HEADERS:UC_CN_API_HEADERS);const p=[/["']stoken["']\s*[:=]\s*["']([^"']+)["']/i,/["']share_token["']\s*[:=]\s*["']([^"']+)["']/i,/stoken%22%3A%22([^%"]+)/i];for(const r of p){const m=html.match(r);if(m?.[1])return m[1];}const $=cheerio.load(html);let x:string|null=null;$("script").each((_,s)=>{if(x)return;const t=$(s).html()||"";for(const r of p){const m=t.match(r);if(m?.[1]){x=m[1];break;}}});return x;}catch{return null;}}

async function extractViaApi(pwdId:string,passcode:string,intl:boolean,pageUrl:URL):Promise<ExtractedMedia>{
 const api=intl?UC_INTL_API:UC_CN_API,h=intl?UC_INTL_API_HEADERS:UC_CN_API_HEADERS;let stoken=await discoverStoken(pageUrl,intl);let root:Record<string,unknown>|null=null;
 const body={pwd_id:pwdId,passcode:passcode||"",force:0,page:1,size:PAGE_SIZE,fetch_banner:1,fetch_share:1,fetch_total:1,sort:"",banner_platform:"others",fetch_error_background:1,web_platform:"others",fetch_follow_status:1,ip_limit:"",...(stoken?{stoken}:{})};
 try{root=await json(`${api}/share/sharepage/v2/detail?pr=UCBrowser&fr=h5`,{method:"POST",body:JSON.stringify(body),headers:{"Content-Type":"application/json"}},h);}catch(e){if(!stoken)throw e;}
 const data=(root?.data||{}) as Record<string,unknown>,ti=(data.token_info||{}) as Record<string,unknown>,di=(data.detail_info||{}) as Record<string,unknown>,share=(di.share||{}) as Record<string,unknown>;
 stoken=String(ti.stoken||stoken||"");if(!stoken)throw new ExtractionError("UC did not expose a public share token.",422);
 const title=String(ti.title||share.title||"")||undefined,shareSize=typeof share.size==="number"?share.size:undefined;
 async function listDir(fid:string){const all:UcListItem[]=[];for(let p=1;p<=100;p++){const q=new URLSearchParams({pr:"UCBrowser",fr:"h5",pwd_id:pwdId,stoken,pdir_fid:fid,force:fid==="0"?"0":"1",_page:String(p),_size:String(PAGE_SIZE),_fetch_banner:"0",_fetch_share:"0",_fetch_total:"1",_sort:"file_type:asc,file_name:asc"});const j=await json(`${api}/share/sharepage/detail?${q}`,{method:"GET"},h);const d=(j.data||{}) as Record<string,unknown>,rows=Array.isArray(d.list)?d.list as UcListItem[]:[];if(!rows.length)break;all.push(...rows);if(rows.length<PAGE_SIZE)break;}return all;}
 async function candidates(){const out:UcListItem[][]=[];const direct=Array.isArray(di.list)?di.list as UcListItem[]:[];if(direct.length)out.push(direct);
  const fids=[String(di.fid||di.file_id||share.fid||share.file_id||"0")];for(const f of fids){try{const x=await listDir(f);if(x.length)out.push(x);}catch{}}
  // UC share UIs can use the share root's fid token as the parent id. Try the explicit root token/fid fields when present.
  for(const k of ["share_fid","share_fid_token","fid_token"]){const v=String(di[k]||share[k]||"");if(v&&v!==fids[0]){try{const x=await listDir(v);if(x.length)out.push(x);}catch{}}}
  return out.sort((a,b)=>b.length-a.length)[0]||[];
 }
 const rootList=await candidates();
 if(!rootList.length)throw new ExtractionError(`UC exposed the folder metadata "${title||"unknown"}"${shareSize?` (~${formatBytes(shareSize)})`:""}, but its anonymous listing endpoint returned no child entries.`,422);
 const q:{fid:string;depth:number;prefix:string}[]=[],files:UcListItem[]=[],seen=new Set<string>();let folder=false;
 for(const i of rootList){if(isDirItem(i)){folder=true;if(i.fid&&!seen.has(i.fid)){seen.add(i.fid);q.push({fid:i.fid,depth:1,prefix:i.file_name||""});}}else files.push(i);}
 while(q.length&&files.length<MAX_TOTAL_FILES){const cur=q.shift()!;if(cur.depth>MAX_FOLDER_DEPTH)continue;let rows:UcListItem[]=[];try{rows=await listDir(cur.fid);}catch{continue;}for(const i of rows){if(isDirItem(i)){folder=true;if(cur.depth<MAX_FOLDER_DEPTH&&i.fid&&!seen.has(i.fid)){seen.add(i.fid);q.push({fid:i.fid,depth:cur.depth+1,prefix:cur.prefix?`${cur.prefix}/${i.file_name}`:i.file_name});}}else{files.push({...i,file_name:cur.prefix?`${cur.prefix}/${i.file_name}`:i.file_name});if(files.length>=MAX_TOTAL_FILES)break;}}}
 if(!files.length)throw new ExtractionError(`UC listed the share but no playable files were found in its anonymous folders.`,422);
 files.sort((a,b)=>(EXT_PRIORITY[extFromName(b.file_name||"")||""]??10)-(EXT_PRIORITY[extFromName(a.file_name||"")||""]??10));
 const resolved:FileEntry[]=[];
 for(const f of files.slice(0,MAX_TOTAL_FILES)){try{const qv=new URLSearchParams({pr:"UCBrowser",fr:"h5",pwd_id:pwdId,stoken,fid:f.fid,share_fid_token:f.share_fid_token||"",resolutions:"normal,high,super,2k,4k",supports:"fmp4,m3u8"});const j=await json(`${api}/share/sharepage/video_preview?${qv}`,{method:"GET"},h);const urls=[...JSON.stringify(j.data||{}).matchAll(/https?:\/\/[^"\s]+/g)].map(m=>m[0].replace(/\\\//g,"/"));const u=urls.find(x=>/\.(mp4|m3u8)(?:\?|$)/i.test(x))||urls[0];if(u){const e=extFromName(f.file_name||"")||"bin";resolved.push({name:f.file_name||"file",directUrl:u,mediaType:classify(e),size:f.size!=null?formatBytes(f.size):undefined,sizeBytes:f.size});}}catch{}}
 if(!resolved.length)throw new ExtractionError(`UC returned ${files.length} file entries, but no anonymous media URL was exposed.`,422);const best=resolved[0];return{directUrl:best.directUrl,mediaType:best.mediaType,title:title||best.name,size:best.size,method:intl?"UC Intl public share flow":"UC CN public share flow",files:resolved.length>1?resolved:undefined,isFolder:folder||resolved.length>1};
}
export async function extractFromPage(pageUrl:URL,options?:{passcode?:string}):Promise<ExtractedMedia>{const id=extractShareId(pageUrl);if(!id)throw new ExtractionError("Could not parse share id from URL.",400);const pass=extractPasscode(pageUrl,options?.passcode),intl=isIntlShareHost(pageUrl);try{return await extractViaApi(id,pass,intl,pageUrl);}catch(e){if(!intl)throw e;try{return await extractViaApi(id,pass,false,pageUrl);}catch{throw e;}}}
