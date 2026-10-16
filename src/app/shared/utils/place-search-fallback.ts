import {Observable,of,throwError,timer,catchError,switchMap} from 'rxjs';
import {AutocompleteResult} from '../../core/models/maps/route-result.model';

/** Delay the second provider until typing has settled. Unsubscribing cancels
 * both the pending delay and an active HTTP request. Never changes the scope. */
export function automaticPlaceSearch(
    primary:Observable<AutocompleteResult[]>,
    additional:()=>Observable<AutocompleteResult[]>,
    eligible:boolean
):Observable<AutocompleteResult[]>{
    const next=()=>timer(600).pipe(switchMap(()=>additional()));
    // Catch only errors from primary, not errors thrown by the second provider.
    return primary.pipe(
        catchError(error=>eligible && error?.code==='provider_unavailable'?of(null):throwError(()=>error)),
        switchMap(results=>eligible && (!results || !results.length)?next():of(results || []))
    );
}
