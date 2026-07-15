function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

// This program deliberately parses dotenv as data. It is passed to the remote
// Node runtime with `-e`, so values from the dotenv file never become shell
// syntax. It supports the dotenv forms Node applications commonly use:
// comments, `export KEY=...`, quoted values and quoted multiline values.
const dotenvRunner = String.raw`const fs=require('node:fs');const{spawn}=require('node:child_process');const[file,encodedEnv,command,...args]=process.argv.slice(1);const text=fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'');const parsed={};const line=/(?:^|\n)\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*\x60(?:\\\x60|[^\x60])*\x60|[^\n]*)/g;let match;while((match=line.exec(text))!==null){let value=match[2].trim();const quote=value[0];if((quote==='"'||quote==="'"||quote==='\x60')&&value.at(-1)===quote){value=value.slice(1,-1);if(quote==='"')value=value.replace(/\\n/g,'\n').replace(/\\r/g,'\r');}else{value=value.replace(/\s+#.*$/,'').trim();}parsed[match[1]]=value;}const explicit=JSON.parse(Buffer.from(encodedEnv,'base64url').toString('utf8'));Object.assign(process.env,parsed,explicit);const child=spawn(command,args,{env:process.env,stdio:'inherit'});child.on('error',error=>{console.error(error.message);process.exit(1);});child.on('exit',(code,signal)=>process.exit(code??(signal?1:0)));`;

/**
 * Runs a shell command with values parsed from a dotenv file without sourcing
 * that file. Explicit process values win over the dotenv file.
 */
export function runWithDotenv(
  envFile: string | undefined,
  command: string,
  explicitEnvironment: Record<string, string | number> = {},
): string {
  if (!envFile) return command;

  const encodedEnvironment = Buffer.from(JSON.stringify(explicitEnvironment)).toString('base64url');
  return `node -e ${shellSingleQuote(dotenvRunner)} -- ` +
    `${shellSingleQuote(envFile)} ${shellSingleQuote(encodedEnvironment)} bash -c ${shellSingleQuote(command)}`;
}
