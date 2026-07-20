export interface IngressOriginRequest {
  noTLSVerify?: boolean;
  originServerName?: string;
  httpHostHeader?: string;
}

export interface Ingress {
  hostname?: string;
  service: string;
  originRequest?: IngressOriginRequest;
}
