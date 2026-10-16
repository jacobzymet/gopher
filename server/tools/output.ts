function utf8Prefix(bytes:Buffer,length:number):Buffer{let end=Math.min(bytes.length,length);if(end<bytes.length)while(end>0&&(bytes[end]&0xc0)===0x80)end--;else if(end){let start=end-1;while(start>0&&(bytes[start]&0xc0)===0x80)start--;const lead=bytes[start],needed=lead>=240?4:lead>=224?3:lead>=192?2:1;if(start+needed>end)end=start;}return bytes.subarray(0,end);}
function utf8Suffix(bytes:Buffer,length:number):Buffer{let start=Math.max(0,bytes.length-length);while(start<bytes.length&&(bytes[start]&0xc0)===0x80)start++;return bytes.subarray(start);}
export function truncateText(text:string,maxBytes:number):string{const bytes=Buffer.from(text);if(bytes.length<=maxBytes)return text;const marker=Buffer.from('\n… output omitted …\n');if(maxBytes<marker.length)return '[truncated]'.slice(0,maxBytes);const available=maxBytes-marker.length;return Buffer.concat([utf8Prefix(bytes,Math.floor(available/2)),marker,utf8Suffix(bytes,available-Math.floor(available/2))]).toString();}
/** A bounded per-poll output buffer, preserving initial context and final errors. */
export class BoundedOutput{
  private head=Buffer.alloc(0);private tail=Buffer.alloc(0);private total=0;
  constructor(readonly limit=32_000){}
  push(value:string|Buffer):void{const bytes=typeof value==='string'?Buffer.from(value):value;this.total+=bytes.length;const take=Math.min(bytes.length,Math.max(0,Math.floor(this.limit/2)-this.head.length));if(take)this.head=Buffer.concat([this.head,bytes.subarray(0,take)]);const rest=bytes.subarray(take);this.tail=Buffer.concat([this.tail,rest]);if(this.tail.length>this.limit-Math.floor(this.limit/2))this.tail=this.tail.subarray(-(this.limit-Math.floor(this.limit/2)));}
  get empty():boolean{return this.total===0;}
  get truncated():boolean{return this.total>this.limit;}
  render():string{if(this.total<=this.limit)return Buffer.concat([this.head,this.tail]).toString();const marker=Buffer.from(`\n… ${this.total-this.limit} bytes omitted …\n`);return truncateText(Buffer.concat([utf8Prefix(this.head,this.head.length),marker,utf8Suffix(this.tail,this.tail.length)]).toString(),this.limit);}
  take():string{const result=this.render();this.head=Buffer.alloc(0);this.tail=Buffer.alloc(0);this.total=0;return result;}
}
