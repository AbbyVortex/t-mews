import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseFeed} from '../src/sources';

const source={name:'fxtwitter',url:'https://fxtwitter.com/thsottiaux/feed.xml?with_replies=true&count=100'};
const rss=(content:string,extra='')=>`<rss version="2.0" xmlns:th="http://purl.org/syndication/thread/1.0"><channel><title>Tibo (@thsottiaux)</title><item><title>Reply</title><link>https://x.com/thsottiaux/status/100</link><pubDate>Sat, 12 Sep 2026 03:20:36 GMT</pubDate>${extra}<description><![CDATA[${content}]]></description></item></channel></rss>`;

test('live FxTwitter fixture separates quote text and filters foreign timeline items',async()=>{
 const items=await parseFeed(readFileSync(new URL('./fixtures/fxtwitter-context-2026-09-12.xml',import.meta.url),'utf8'),source);
 assert.equal(items.length,3);
 const quote=items.find(item=>item.xStatusId==='2098569538510180712')!;
 assert.equal(quote.text,'Massive upgrade to creating, sharing and hosting sites directly through ChatGPT.');
 assert.equal(quote.related?.length,1);
 assert.deepEqual({...quote.related![0],text:undefined},{relation:'quote',xStatusId:'2098457920291946894',url:'https://x.com/ChatGPT/status/2098457920291946894',author:'ChatGPT',text:undefined,provenance:'feed'});
 assert.match(quote.related![0].text!,/^Three months ago/);
 const reply=items.find(item=>item.xStatusId==='2098115478644523392')!;
 assert.equal(reply.kind,'reply');
 assert.equal(reply.related,undefined,'a nearby foreign item must not be inferred to be the parent');
 const reset=items.find(item=>item.xStatusId==='2098300424520687965')!;
 assert.match(reset.text,/occasional reset/);
 assert.equal(reset.related,undefined,'the live RSS does not provide a reply parent ID');
});

test('quoted reset is context, never part of the author’s own body',async()=>{
 const [item]=await parseFeed(rss('<p>👀</p><blockquote><a href="https://x.com/another/status/200?s=20">A reset will arrive tomorrow &amp; everyone gets it.</a></blockquote>'),source);
 assert.equal(item.text,'👀');
 assert.deepEqual(item.related,[{relation:'quote',xStatusId:'200',url:'https://x.com/another/status/200',author:'another',text:'A reset will arrive tomorrow & everyone gets it.',provenance:'feed'}]);
});

test('empty quote commentary remains observable without promoting the quoted author to Tibo',async()=>{
 const [item]=await parseFeed(rss('<p></p><blockquote><a href="https://x.com/other/status/200">Reset announced</a></blockquote>'),source);
 assert.equal(item.text,'');
 assert.equal(item.xStatusId,'100');
 assert.equal(item.related?.[0].author,'other');
});

for(const text of ['Yes','👀','18:00 UTC']) test(`explicit Atom threading preserves short reply: ${text}`,async()=>{
 const atom=`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:thread="http://purl.org/syndication/thread/1.0"><title>Tibo (@thsottiaux)</title><entry><id>https://x.com/thsottiaux/status/100</id><link href="https://x.com/thsottiaux/status/100"/><content type="html">${text}</content><thread:in-reply-to ref="https://x.com/other/status/200" href="https://x.com/other/status/200"/></entry></feed>`;
 const [item]=await parseFeed(atom,source);
 assert.equal(item.text,text);assert.equal(item.kind,'reply');
 assert.deepEqual(item.related,[{relation:'reply',xStatusId:'200',url:'https://x.com/other/status/200',author:'other',provenance:'feed'}]);
});

test('explicit RSS threading supports href when ref is an opaque identifier',async()=>{
 const [item]=await parseFeed(rss('<p>Tomorrow</p>','<th:in-reply-to ref="tag:example:parent" href="https://x.com/i/status/200"/>'),source);
 assert.deepEqual(item.related,[{relation:'reply',xStatusId:'200',url:'https://x.com/i/status/200',provenance:'feed'}]);
});

test('unavailable parent does not drop a reply or invent context',async()=>{
 const [item]=await parseFeed(rss('<p>@other Reset will land tomorrow</p>'),source);
 assert.match(item.text,/Reset will land tomorrow/);assert.equal(item.related,undefined);
 const [short]=await parseFeed(rss('<p>👀</p>'),source);
 assert.equal(short.text,'👀');assert.equal(short.related,undefined);
});

test('ordinary links, unrelated namespaces and conflicting references do not create relationships',async()=>{
 for(const content of [
  '<p>See <a href="https://x.com/other/status/200">a reset announcement</a></p>',
  '<p>👀</p><blockquote>Reset announced, but no identifiable original post.</blockquote>',
  '<p>👀</p><blockquote><a href="https://unrelated.example/other/status/200">Reset</a></blockquote>',
  '<p>👀</p><blockquote><a href="https://x.com/other/status/200">A reset</a><a href="https://x.com/other/status/201">Another reset</a></blockquote>'
 ]) assert.equal((await parseFeed(rss(content),source))[0].related,undefined);
 assert.equal((await parseFeed(rss('👀','<other:in-reply-to xmlns:other="https://unrelated.example" ref="https://x.com/other/status/200"/>'),source))[0].related,undefined);
 assert.equal((await parseFeed(rss('👀','<th:in-reply-to ref="https://x.com/other/status/200" href="https://x.com/other/status/201"/>'),source))[0].related,undefined);
});

test('quote attributes, whitespace and entities normalize with no duplicate relationships',async()=>{
 const quote="<blockquote class='quoted'><a title='post' href = 'https://twitter.com/Other/status/200?x=1&amp;y=2'>Reset&#39;s here<br />today</a></blockquote>";
 const [item]=await parseFeed(rss(`<p>Confirmed</p>${quote}${quote}`),source);
 assert.equal(item.related?.length,1);
 assert.equal(item.related![0].text,"Reset's here\ntoday");
 assert.equal(item.related![0].url,'https://x.com/Other/status/200');
});
