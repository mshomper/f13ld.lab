/* harness: evals the (read-only) F13LD.lab solver files + febuckle prototype into global scope, then runs scripts given as args */
var fs=require('fs');
global.require=require;
global.window=global; global.document={getElementById:function(){return null},baseURI:'http://x/'};
global.performance=require('perf_hooks').performance;
var DIR=process.env.SRC||require('path').resolve(__dirname,'../..');
var FE=__dirname; global.FEDIR=__dirname;
var files=(process.env.FILES||'18-stokes-cpu-ref.js,14-rasterizer.js,14a-connectivity.js,13-kernels.js,13b-kernels-new.js,15-demo-recipes.js,15b-demo-recipes-new.js,16a-elastic-cpu-ref-full.js,16c-buckling-cpu-ref.js').split(',');
var src=files.map(function(f){return fs.readFileSync(DIR+'/'+f,'utf8')}).join('\n');
src+='\n'+['lobpcg.js','fe.js','mg.js'].filter(function(f){return fs.existsSync(FE+'/'+f)}).map(function(f){return fs.readFileSync(FE+'/'+f,'utf8')}).join('\n');
(0,eval)(src);
var extra=process.argv.slice(2);
for (var i=0;i<extra.length;i++){ var t0=performance.now(); (0,eval)(fs.readFileSync(extra[i],'utf8')); console.log('['+extra[i]+'] '+((performance.now()-t0)/1000).toFixed(2)+' s'); }
