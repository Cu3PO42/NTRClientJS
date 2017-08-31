import NtrClient from './ntrclient';
export default function search(client: NtrClient, pid: number, value: number, locations?: number[]): Promise<number[]>;
