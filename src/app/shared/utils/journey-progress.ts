export interface NavigationStep {instruction:string;distanceMeters:number;durationSeconds:number;startIndex:number;endIndex:number;}
export interface NavigationRoute {coordinates:number[][];steps:NavigationStep[];distanceMeters:number;durationSeconds:number;}
export function distanceMeters(a:number[],b:number[]):number {
 const r=Math.PI/180;const lat=(b[1]-a[1])*r;const lon=(b[0]-a[0])*r;
 const h=Math.sin(lat/2)**2+Math.cos(a[1]*r)*Math.cos(b[1]*r)*Math.sin(lon/2)**2;
 return 6371000*2*Math.atan2(Math.sqrt(h),Math.sqrt(Math.max(0,1-h)));
}
export function journeyProgress(route:NavigationRoute,point:{lat:number;lng:number},previousIndex=0) {
 let index=previousIndex,best=Infinity,along=0;
 const origin=[point.lng,point.lat];
 // Project onto segments so sparse route geometry does not look off-route.
 for(let i=Math.max(0,previousIndex-1);i<route.coordinates.length-1;i++) {
  const a=route.coordinates[i],b=route.coordinates[i+1];
  const scale=Math.cos(point.lat*Math.PI/180);
  const x=(b[0]-a[0])*scale,y=b[1]-a[1];
  const px=(origin[0]-a[0])*scale,py=origin[1]-a[1];
  const t=x*x+y*y>0?Math.max(0,Math.min(1,(px*x+py*y)/(x*x+y*y))):0;
  const projected=[a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])];
  const d=distanceMeters(origin,projected);
  if(d<best){index=t>=0.999?i+1:i;best=d;along=distanceMeters(projected,b);}
 }
 if(best>75) return {index:previousIndex,offRoute:true,remainingMeters:null,remainingSeconds:null,step:null};
 const selected=index;index=Math.max(previousIndex,index);let remaining=selected<previousIndex?0:along;
 for(let i=index+1;i<route.coordinates.length;i++) {
  if(i===selected+1 && selected>=previousIndex && along>0) continue;
  remaining+=distanceMeters(route.coordinates[i-1],route.coordinates[i]);
 }
 const step=route.steps.find(s=>s.endIndex>index)||route.steps[route.steps.length-1]||null;
 return {index,offRoute:false,remainingMeters:Math.round(remaining),remainingSeconds:route.distanceMeters>0?Math.round(route.durationSeconds*remaining/route.distanceMeters):0,step};
}
