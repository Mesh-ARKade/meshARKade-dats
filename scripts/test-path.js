console.log('import.meta.url:', import.meta.url);
console.log('process.argv[1]:', process.argv[1]);
import { pathToFileURL } from 'url';
const argvUrl = pathToFileURL(process.argv[1]).href;
console.log('pathToFileURL(process.argv[1]):', argvUrl);
console.log('Match?', import.meta.url === argvUrl);
