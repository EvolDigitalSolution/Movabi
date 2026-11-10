export type RoadPoint={lat:number;lng:number};
export function roadDistance(a:RoadPoint,b:RoadPoint):number {
 const scale=Math.cos((a.lat+b.lat)*Math.PI/360);
 return Math.hypot((a.lng-b.lng)*scale,a.lat-b.lat)*111195;
}
export function matchRoadPoint(route:number[][],point:RoadPoint):{point:RoadPoint;index:number;t:number;distance:number}|null {
 let best:{point:RoadPoint;index:number;t:number;distance:number}|null=null;
 for(let i=0;i<route.length-1;i++){
  const a=route[i],b=route[i+1];if(!a||!b||![...a,...b,point.lat,point.lng].every(Number.isFinite))continue;
  const scale=Math.cos(point.lat*Math.PI/180),x=(b[0]-a[0])*scale,y=b[1]-a[1];
  const t=Math.max(0,Math.min(1,(x*x+y*y)?(((point.lng-a[0])*scale*x+(point.lat-a[1])*y)/(x*x+y*y)):0));
  const p={lng:a[0]+t*(b[0]-a[0]),lat:a[1]+t*(b[1]-a[1])},distance=roadDistance(point,p);
  if(!best||distance<best.distance)best={point:p,index:i,t,distance};
 }
 return best&&best.distance<=40?best:null;
}
export function roadMotionPath(route:number[][],from:RoadPoint,to:RoadPoint):RoadPoint[]|null {
 const a=matchRoadPoint(route,from),b=matchRoadPoint(route,to);
 if(!a||!b||b.index+b.t<a.index+a.t)return null;
 const path=[a.point,...route.slice(a.index+1,b.index+1).map(p=>({lng:p[0],lat:p[1]})),b.point];
 const length=path.slice(1).reduce((n,p,i)=>n+roadDistance(path[i],p),0);
 return length<=500&&length<=roadDistance(from,to)*4+50?path:null;
}
export function sampleRoadPath(path:RoadPoint[],fraction:number):RoadPoint {
 const lengths=path.slice(1).map((p,i)=>roadDistance(path[i],p));const total=lengths.reduce((a,b)=>a+b,0);
 let remaining=Math.max(0,Math.min(1,fraction))*total;
 for(let i=0;i<lengths.length;i++){if(remaining<=lengths[i]){const t=lengths[i]?remaining/lengths[i]:1;return {lat:path[i].lat+(path[i+1].lat-path[i].lat)*t,lng:path[i].lng+(path[i+1].lng-path[i].lng)*t};}remaining-=lengths[i];}
 return path[path.length-1];
}
