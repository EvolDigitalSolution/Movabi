export function driverPaidNegotiation(job:any,driverId:string|null|undefined):boolean {
 return !!driverId&&job?.driver_id===driverId&&
 ['assigned','accepted','heading_to_pickup','arrived','arrived_at_store','shopping_in_progress','collected','en_route_to_customer','in_progress','delivered'].includes(String(job.status||'').toLowerCase())&&
 ['authorized','paid','captured'].includes(String(job.payment_status||'').toLowerCase());
}
