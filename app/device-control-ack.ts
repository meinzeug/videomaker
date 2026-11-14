/** A displayed value alone may predate the command; require its exact phone ACK. */
export type PendingSetting={deviceId:string;commandId:string;field:'speed'|'fontSize';value:number};
export type DeviceSettingStatus={id:string;speed:number|null;fontSize:number|null;acknowledged?:string[]};
export function settingConfirmed(pending:PendingSetting,device:DeviceSettingStatus|undefined):boolean{
 if(!device||device.id!==pending.deviceId||!Array.isArray(device.acknowledged)||!device.acknowledged.includes(pending.commandId))return false;
 const value=device[pending.field];
 return typeof value==='number'&&Number.isFinite(value)&&Math.abs(value-pending.value)<0.001;
}
