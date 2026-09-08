import { fetchSource } from '../src/sources';
import { classify } from '../src/classifier';
const result=await fetchSource({name:'fxtwitter',url:'https://fxtwitter.com/thsottiaux/feed.xml'});
console.log(JSON.stringify({checkedAt:new Date().toISOString(),source:'fxtwitter',items:result.length,latest:result[0],classifications:result.map(p=>({id:p.id,classification:classify(p.text),text:p.text.slice(0,150)}))},null,2));
