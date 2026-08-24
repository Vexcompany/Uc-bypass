import { NextRequest, NextResponse } from "next/server";
import { extractFromPage, ExtractionError } from "@/lib/extract";
import { parsePageUrl } from "@/lib/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ success:false,error:'Request body must be valid JSON: { "url": "…" }' },{status:400}); }
  const obj=body as {url?:unknown;passcode?:unknown};
  const raw=typeof obj?.url==="string"?obj.url.trim():"";
  const passcode=typeof obj?.passcode==="string"?obj.passcode.trim():undefined;
  if(!raw)return NextResponse.json({success:false,error:"Missing required field: url."},{status:400});
  const pageUrl=parsePageUrl(raw);
  if(!pageUrl)return NextResponse.json({success:false,error:"Invalid URL. Only http(s) links on uc-share.com, drive.uc.cn, fast.uc.cn (or their subdomains) are supported."},{status:400});
  try{
    const media=await extractFromPage(pageUrl,{passcode});
    let sourceDomain=pageUrl.hostname;
    if(media.directUrl){try{sourceDomain=new URL(media.directUrl).hostname;}catch{}}
    const hasContent=Boolean(media.directUrl)||(media.files?.length??0)>0||(media.folders?.length??0)>0;
    if(!hasContent)throw new ExtractionError("UC returned an empty share result.",422);
    return NextResponse.json({success:true,title:media.title,directUrl:media.directUrl||undefined,mediaType:media.mediaType,size:media.size,resolution:media.resolution,method:media.method,sourceDomain,isFolder:media.isFolder??false,files:media.files?.length?media.files:undefined,folders:media.folders?.length?media.folders:undefined});
  }catch(err){
    if(err instanceof ExtractionError)return NextResponse.json({success:false,error:err.message},{status:err.status>=400&&err.status<=599?err.status:422});
    console.error("[extract] unexpected error:",err);
    return NextResponse.json({success:false,error:"Unexpected server error while resolving the page. Please try again."},{status:500});
  }
}

export async function GET(){return NextResponse.json({endpoint:"POST /api/extract",body:{url:"https://uc-share.com/s/<share-id> or https://drive.uc.cn/s/<share-id>",passcode:"optional share passcode"},response:{success:"boolean",title:"string?",directUrl:"string?",mediaType:"'video' | 'file'?",isFolder:"boolean?",folders:"Array<{ name, fid, path, itemCount? }>?",files:"Array<{ name, directUrl?, mediaType, size?, fid?, shareFidToken? }>?",error:"string?"}});}
