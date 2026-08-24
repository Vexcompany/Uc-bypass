import * as cheerio from "cheerio";
import {
  SPOOFED_HEADERS,
  UC_INTL_API_HEADERS,
  UC_CN_API_HEADERS,
  extractPasscode,
  extractShareId,
  formatBytes,
  isIntlShareHost,
} from "@/lib/shared";

export type MediaType = "video" | "file";
export interface FileEntry { name: string; directUrl: string; mediaType: MediaType; size?: string; sizeBytes?: number; isFolder?: boolean; }
export interface ExtractedMedia { directUrl: string; mediaType: MediaType; title?: string; size?: string; resolution?: string; method: string; files?: FileEntry[]; isFolder?: boolean; }
export class ExtractionError extends Error { status: number; constructor(message: string, status = 422) { super(message); this.name = "ExtractionError"; this.status = status; } }
interface UcListItem { fid: string; file_name: string; size?: number; dir?: boolean; file?: boolean; file_type?: number; format_type?: string; share_fid_token?: string; include_items?: number; }

const VIDEO_EXT_LIST = ["mp4","m3u8","webm","mkv","mov","m4v","avi","ts","3gp","ogv","flv"];
const EXT_PRIORITY: Record<string, number> = { mp4:60,m3u8:55,webm:50,m4v:45,mov:45,mkv:40,mp3:35,ts:30,avi:30,flv:25,ogv:25,"3gp":20 };
const MAX_FOLDER_DEPTH = 5;
const MAX_TOTAL_FILES = 200;
const PAGE_SIZE = 100;
const UC_INTL_API = "https://m-intldrive.ucweb.com/1/clouddrive";
const UC_CN_API = "https://pc-api.uc.cn/1/clouddrive";

function extFromName(name:string):string|null { const m=name.match(/\.([a-z0-9]{1,5})$/i); return m?m[1].toLowerCase():null; }
function classify(ext:string):MediaType { return VIDEO_EXT_LIST.includes(ext)?"video":"file"; }
function isDirItem(item:UcListItem):boolean { return item.dir===true || item.file===false || item.file_type===0 || (item.include_items!=null && item.include_items>0 && !extFromName(item.file_name||"")); }

async function fetchText(url:string, headers:Record<string,string>):Promise<string> {
  const res=await fetch(url,{headers:{...headers,...SPOOFED_HEADERS},redirect:"follow"});
  if(!res.ok) throw new ExtractionError(`UC share page HTTP ${res.status}`,res.status===404?404:502);
  return await res.text();
}
async function ucFetchJson(url:string, init:RequestInit|undefined, headers:Record<string,string>):Promise<Record<string,unknown>> {
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),18000);
  try { const res=await fetch(url,{...init,headers:{...headers,...(init?.headers as Record<string,string>|undefined)},signal:controller.signal}); if(!res.ok) throw new ExtractionError(`UC API HTTP ${res.status}`,res.status===404?404:502); return await res.json() as Record<string,unknown>; }
  catch(err){ if(err instanceof ExtractionError) throw err; if(controller.signal.aborted) throw new ExtractionError("UC API timeout",504); throw new ExtractionError("Could not reach UC Drive API",502); }
  finally{clearTimeout(timer);}
}

async function discoverStoken(pageUrl:URL, pwdId:string, intl:boolean):Promise<string|null> {
  try {
    const html=await fetchText(pageUrl.toString(),intl?UC_INTL_API_HEADERS:UC_CN_API_HEADERS);
    const patterns=[
      /["']stoken["']\s*[:=]\s*["']([^"']+)["']/i,
      /["']share_token["']\s*[:=]\s*["']([^"']+)["']/i,
      /stoken%22%3A%22([^%"]+)/i,
      /"token_info"\s*:\s*\{[^}]*"stoken"\s*:\s*"([^"]+)"/i,
    ];
    for(const re of patterns){const m=html.match(re);if(m?.[1])return m[1];}
    const $=cheerio.load(html);
    let found:string|null=null;
    $("script").each((_,el)=>{if(found)return;const t=$(el).html()||"";for(const re of patterns){const m=t.match(re);if(m?.[1]){found=m[1];return;}}});
    return found;
  } catch { return null; }
}

async function extractViaApi(pwdId:string,passcode:string,intl:boolean,pageUrl:URL):Promise<ExtractedMedia>{
  const api=intl?UC_INTL_API:UC_CN_API; const headers=intl?UC_INTL_API_HEADERS:UC_CN_API_HEADERS;
  let stoken=await discoverStoken(pageUrl,pwdId,intl);
  let rootJson:Record<string,unknown>|null=null;
  const rootBody={pwd_id:pwdId,passcode:passcode||"",force:0,page:1,size:PAGE_SIZE,fetch_banner:1,fetch_share:1,fetch_total:1,sort:"",banner_platform:"others",fetch_error_background:1,web_platform:"others",fetch_follow_status:1,ip_limit:""};
  try { rootJson=await ucFetchJson(`${api}/share/sharepage/v2/detail?pr=UCBrowser&fr=h5`,{method:"POST",body:JSON.stringify({...rootBody,...(stoken?{stoken}: {})})},headers); }
  catch { if(!stoken) throw new ExtractionError("Could not initialize anonymous UC share access.",422); }
  const data=((rootJson?.data||{}) as Record<string,unknown>); const tokenInfo=((data.token_info||{}) as Record<string,unknown>); const detailInfo=((data.detail_info||{}) as Record<string,unknown>);
  stoken=String(tokenInfo.stoken||stoken||""); if(!stoken) throw new ExtractionError("UC did not expose a public share token.",422);
  const share=detailInfo.share as Record<string,unknown>|undefined; let title=String(tokenInfo.title||share?.title||"")||undefined; const shareSize=typeof share?.size==="number"?share.size:undefined;
  let rootList=Array.isArray(detailInfo.list)?detailInfo.list as UcListItem[]:[];

  async function listDir(pdirFid:string):Promise<UcListItem[]> { const all:UcListItem[]=[]; for(let page=1;page<=100;page++){const qs=new URLSearchParams({pr:"UCBrowser",fr:"h5",pwd_id:pwdId,stoken,pdir_fid:pdirFid,force:pdirFid==="0"?"0":"1",_page:String(page),_size:String(PAGE_SIZE),_fetch_banner:"0",_fetch_share:"0",_fetch_total:"1",_sort:"file_type:asc,file_name:asc"}); const json=await ucFetchJson(`${api}/share/sharepage/detail?${qs}`,{method:"GET"},headers); const d=(json.data||{}) as Record<string,unknown>; const rows=Array.isArray(d.list)?d.list as UcListItem[]:[]; if(!rows.length)break; all.push(...rows); if(rows.length<PAGE_SIZE)break;} return all; }

  // Some UC builds return only share metadata from v2/detail. If so, explicitly list the share root using its fid.
  if(!rootList.length){
    const rootFid=String((detailInfo.fid||detailInfo.file_id||share?.fid||share?.file_id||"0"));
    try{rootList=await listDir(rootFid);}catch{}
  }
  if(!rootList.length) throw new ExtractionError(`UC returned the folder metadata "${title||"unknown"}"${shareSize&&shareSize>0?` (~${formatBytes(shareSize)})`:""}, but did not return any child entries for this anonymous request. This may be an access restriction or an incompatible listing request.`,422);

  const queue:{fid:string;depth:number;pathPrefix:string}[]=[]; const mediaFiles:UcListItem[]=[]; let sawFolder=false;
  if(rootList.length===1&&isDirItem(rootList[0])){sawFolder=true;title=rootList[0].file_name||title;queue.push({fid:rootList[0].fid,depth:1,pathPrefix:rootList[0].file_name||""});}
  else for(const item of rootList){if(isDirItem(item)){sawFolder=true;queue.push({fid:item.fid,depth:1,pathPrefix:item.file_name||""});}else mediaFiles.push(item);}
  while(queue.length&&mediaFiles.length<MAX_TOTAL_FILES){const cur=queue.shift()!;if(cur.depth>MAX_FOLDER_DEPTH)continue;let list:UcListItem[]=[];try{list=await listDir(cur.fid);}catch{continue;}for(const item of list){if(isDirItem(item)){sawFolder=true;if(cur.depth<MAX_FOLDER_DEPTH)queue.push({fid:item.fid,depth:cur.depth+1,pathPrefix:cur.pathPrefix?`${cur.pathPrefix}/${item.file_name}`:item.file_name});}else{mediaFiles.push({...item,file_name:cur.pathPrefix?`${cur.pathPrefix}/${item.file_name}`:item.file_name});if(mediaFiles.length>=MAX_TOTAL_FILES)break;}}}
  if(!mediaFiles.length)throw new ExtractionError(`UC exposed the share but no child files were available anonymously.`,422);
  mediaFiles.sort((a,b)=>(EXT_PRIORITY[extFromName(b.file_name||"")||""]??10)-(EXT_PRIORITY[extFromName(a.file_name||"")||""]??10));
  const resolved:FileEntry[]=[];
  for(const f of mediaFiles.slice(0,MAX_TOTAL_FILES)){try{const qs=new URLSearchParams({pr:"UCBrowser",fr:"h5",pwd_id:pwdId,stoken,fid:f.fid,share_fid_token:f.share_fid_token||"",resolutions:"normal,high,super,2k,4k",supports:"fmp4,m3u8"});const j=await ucFetchJson(`${api}/share/sharepage/video_preview?${qs}`,{method:"GET"},headers);const blob=JSON.stringify(j.data||{});const found=[...blob.matchAll(/https?:\/\/[^"\s]+/g)].map(m=>m[0].replace(/\\\//g,"/"));const url=found.find(u=>/\.(mp4|m3u8)(?:\?|$)/i.test(u))||found[0];if(url){const ext=extFromName(f.file_name||"")||"bin";resolved.push({name:f.file_name||"file",directUrl:url,mediaType:classify(ext),size:f.size!=null?formatBytes(f.size):undefined,sizeBytes:f.size});}}catch{}}
  if(!resolved.length)throw new ExtractionError(`UC returned ${mediaFiles.length} files, but did not expose anonymous media URLs.`,422);
  const best=resolved[0]; return {directUrl:best.directUrl,mediaType:best.mediaType,title:title||best.name,size:best.size,method:intl?"UC Intl public share flow":"UC CN public share flow",files:resolved.length>1?resolved:undefined,isFolder:sawFolder||resolved.length>1};
}

export async function extractFromPage(pageUrl:URL,options?:{passcode?:string}):Promise<ExtractedMedia>{const pwdId=extractShareId(pageUrl);if(!pwdId)throw new ExtractionError("Could not parse share id from URL.",400);const passcode=extractPasscode(pageUrl,options?.passcode);const intl=isIntlShareHost(pageUrl);try{return await extractViaApi(pwdId,passcode,intl,pageUrl);}catch(err){if(!intl)throw err;try{return await extractViaApi(pwdId,passcode,false,pageUrl);}catch{if(err instanceof ExtractionError)throw err;throw new ExtractionError("Unexpected error while contacting UC API.",500);}}}
