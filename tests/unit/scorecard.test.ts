import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ScoreCard } from "../../src/components/ScoreCard";
import type { EvalReport } from "../../src/lib/eval/runner";
it("renders exact score, every failure and execution error",()=>{
  const report={questionVersion:2,results:[
    {question:{id:"1",question:"Passed question"},verdict:{pass:true,reason:"ok"},error:null},
    {question:{id:"2",question:"Failed question"},verdict:{pass:false,reason:"Unsupported"},error:null,answer:{text:"Wrong answer"}},
    {question:{id:"3",question:"Crashed question"},verdict:null,error:"ANSWER_EXECUTION_ERROR"},
  ]} as EvalReport;
  const html=renderToStaticMarkup(createElement(ScoreCard,{report}));
  for(const expected of ["1/3", "Failed question","Unsupported","Wrong answer","Crashed question","Execution error: ANSWER_EXECUTION_ERROR"]) expect(html).toContain(expected);
  expect(renderToStaticMarkup(createElement(ScoreCard))).toContain("No quality test yet for this site");
});
