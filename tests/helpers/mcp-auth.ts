import { newNonce, mcpProof } from "../../src/lib/mcp/contracts";

type Handler = (request:Request,name:string)=>Promise<Response>;
export async function authenticatedMcpRequest(handler:Handler,name:string,args:unknown,secret:string,overrides:Record<string,string>={}) {
  const origin="http://127.0.0.1:3000",body=JSON.stringify(args),nonce=newNonce();
  const headers={host:"127.0.0.1:3000","content-type":"application/json","x-ifd-mcp-nonce":nonce};
  const url=`${origin}/api/mcp/${name}`;
  const response=await handler(new Request(url,{method:"POST",headers:{...headers,"x-ifd-mcp-phase":"challenge"},body}),name);
  const challenge=await response.json();
  return new Request(url,{method:"POST",body,headers:{...headers,"x-ifd-mcp-challenge":challenge.nonce,
    "x-ifd-mcp-proof":mcpProof(secret,"client",[origin,name,body,nonce,challenge.nonce]),...overrides}});
}
