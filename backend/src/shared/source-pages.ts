export function parsePageRange(value:string,pageCount:number):number[] {
  const pages=new Set<number>();
  for(const part of value.split(',')){
    const match=part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if(!match)throw new Error('Enter pages such as 1, 3-5.');
    const start=Number(match[1]),end=Number(match[2]??match[1]);
    if(start<1||end<start||end>pageCount)throw new Error(`Choose pages from 1 to ${pageCount}.`);
    if(end-start>10)throw new Error('Choose at most 10 pages.');
    for(let page=start;page<=end;page++)pages.add(page);
  }
  return [...pages].sort((a,b)=>a-b);
}
