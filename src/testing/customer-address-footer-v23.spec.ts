import {describe,it,expect} from 'vitest';
import {savedCustomerAddress,customerAddressUpdate} from '../app/shared/utils/customer-home-address';
describe('saved customer addresses',()=>{
 it('preserves the full multiline address ahead of legacy mirrors',()=>expect(savedCustomerAddress({home_address:'12 Main Street\nFlat 2\nLagos',address_line1:'12 Main Street'})).toBe('12 Main Street\nFlat 2\nLagos'));
 it('uses legacy fields only when the full address is empty',()=>{expect(savedCustomerAddress({home_address:' ',address_line1:'10 Old Road',current_address:'Elsewhere'})).toBe('10 Old Road');expect(savedCustomerAddress({current_address:'Legacy home'})).toBe('Legacy home');expect(savedCustomerAddress(null)).toBe('');});
 it('saves only the existing address columns and keeps line breaks',()=>expect(customerAddressUpdate(' 12 Main Street\r\nFlat 2\r\nLagos ')).toEqual({home_address:'12 Main Street\nFlat 2\nLagos',address_line1:'12 Main Street'}));
 it('rejects blank and overlong addresses',()=>{expect(()=>customerAddressUpdate('  ')).toThrow();expect(()=>customerAddressUpdate('a'.repeat(601))).toThrow();expect(()=>customerAddressUpdate('a'.repeat(251)+'\nLagos')).toThrow();});
});
