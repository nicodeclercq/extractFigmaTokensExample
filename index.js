const { writeFileSync, mkdirSync, readFileSync } = require('fs');
const fetch = require('node-fetch');

const TOKEN = process.env.FIGMA_API_TOKEN;
const FILE_KEY = '5dEFiujMXZX0nKyde7nZ6n';

const isDefined = (node) => node != null;
const isLeaf = (node) => isDefined(node) && !('children' in node);
const isEllipse = (node) => isDefined(node) && node.type === 'ELLIPSE'; 

const fetchFigmaFile = (key) => {
  return fetch(
    `https://api.figma.com/v1/files/${key}`,
    { headers: { 'X-Figma-Token': TOKEN } }
  )
  .then(response => response.json());
}

const findStyleInTree = (root, styleId) => {
  if(isLeaf(root)) {
    return isEllipse(root) && root.styles && root.styles.fill === styleId
      ? root
      : undefined;
  } else {
    return root.children
      .map((item) => findStyleInTree(item, styleId))
      .reduce(
        (accumulator, current) => isDefined(accumulator)
          ? accumulator
          : current, // we keep the first children that uses the color
        undefined
      );
  }
};

const getStylesFromFile = ({styles}) => Object.entries(styles)
  .filter(([, {styleType}]) => styleType === 'FILL')
  .map(([id, {name}]) => ({name, id}));

const mapStyleToNode = (file, styles) => styles
  .map(({name, id}) => {
    const node = findStyleInTree(file.document, id);
    const color = isEllipse(node) && node.fills[0]
      ? node.fills[0].color
      : undefined;

    return {name, color};
  })
  .filter(({color}) => isDefined(color)); // remove all not used styles

const getStyleColors = (file) => Promise.resolve(file)
  .then(getStylesFromFile)
  .then(styles => mapStyleToNode(file, styles));

const toHex = (value) => Math.round(value * 255);
const formatColor = ({r: red, g: green, b: blue, a: alpha}) => {
  return alpha !== 1
    ? `rgba(${toHex(red)}, ${toHex(green)}, ${toHex(blue)}, ${toHex(alpha)})`
    : `rgb(${toHex(red)}, ${toHex(green)}, ${toHex(blue)})`;
}
const formatName = (name) => name
  .toUpperCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // removes diacritics
  .replace(/\//g, '_') // replaces '/' by '_'
  .replace(/[^a-zA-Z0-9_]/g, '') // removes non alphanumeric or '_' characters

const NEW_LINE = `
`;
const templateSCSS = (styles) => {
  return styles
    .map(({name, color}) => `$${formatName(name)}: ${formatColor(color)};`)
    .join(NEW_LINE);
}

const templateTS = (styles) => {
  return styles
    .map(({name, color}) => `const ${formatName(name)} = '${formatColor(color)}';`)
    .join(NEW_LINE);
}

const templateJSON = (styles) => {
  return `{${NEW_LINE}${styles
    .map(({name, color}) => `  "${formatName(name)}": "${formatColor(color)}"`)
    .join(`,${NEW_LINE}`)
  }${NEW_LINE}}`;
}

const createDir = (path) => {
  try{
    mkdirSync(path);
  }catch(e){
    if(e.code !== 'EEXIST'){ // we don't mind if the folder already exists
      throw e;
    }
  }
};

const readFile = (path) => readFileSync(path).toString('utf-8');

const generateFiles = (styles) => {
  createDir('./build');
  writeFileSync('./build/colors.scss', templateSCSS(styles));
  writeFileSync('./build/colors.ts', templateTS(styles));
  writeFileSync('./build/colors.json', templateJSON(styles));
}

const getState = () => Promise.resolve()
  .then(() => readFile('./build/colors.json'))
  .then(fileContent => ({
    state: 'RETRIEVED',
    data: JSON.parse(fileContent),
  }))
  .catch(e => e.code === 'ENOENT'
    ? Promise.resolve({ // the script has not been run yet
        state: 'EMPTY'
      })
    : Promise.reject(e)
  );

const getAddedData = (lastData, newData) => Object
  .entries(newData)
  .filter(([name]) => !lastData[name])
  .map(([name]) => name);
const getDeletedData = (lastData, newData) => Object
  .entries(lastData)
  .filter(([name]) => !newData[name])
  .map(([name]) => name);
const getUpdatedData = (lastData, newData) => Object
.entries(newData)
.filter(([name, color]) => lastData[name] !== color)
.map(([name]) => name);

const interpretChanges = (lastState, newState ) => {
  if(lastState.state === 'EMPTY'){
    return {
      added: newState.data,
      updated: [],
      deleted: [],
    }
  }
  return {
    added: getAddedData(lastState.data, newState.data),
    updated: getUpdatedData(lastState.data, newState.data),
    deleted: getDeletedData(lastState.data, newState.data),
  }
};

const getVersionType = (changes) => {
  if(changes.deleted.length > 0){
    return 'MAJOR';
  }
  if(changes.added.length > 0 || changes.updated.length > 0){
    return 'MINOR';
  }
  return '';
}

const createVersionBumpType = (lastState) => Promise.resolve()
  .then(getState)
  .then(newState => interpretChanges(lastState, newState))
  .then(getVersionType)
  .then((versionType) => writeFileSync('./VERSION_BUMP_TYPE', versionType))

async function run (){
  if(!TOKEN){
    console.error('The Figma API token is not defined, you need to set an environment variable `FIGMA_API_TOKEN` to run the script');
    return;
  }

  const lastState = await getState();
  
  fetchFigmaFile(FILE_KEY)
    .then(getStyleColors)
    .then(generateFiles)
    .then(() => createVersionBumpType(lastState))
    .then(() => console.log('Done'))
    .catch((error) => console.error('Oops something went wrong: ', error));
}

run();