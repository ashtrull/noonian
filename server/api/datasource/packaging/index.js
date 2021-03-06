/*
Copyright (C) 2016-2018  Eugene Lockett  gene@noonian.org

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/
/**
 * datasource/packaging
 * @module db._svc.PackagingService
 * 
 * Contains logic for building, installing, and versioning noonian packages.
 * 
 */
'use strict';

const Q = require('q');
const _ = require('lodash');

const fs = require('fs');

const serverConf = require('../../../conf');


const db = require('../index');

const GridFsService = require('../gridfs');
const DataTriggerService = require('../datatrigger');

const VersionId = exports.VersionId = require('../version_id'); //versioning for individual business objects

const semver = require('semver');//npm semantic version parsing

const fsPackageSyncer = require('./fs_sync');
const packageStreamer = require('./pkg_stream');

exports.buildPackage = packageStreamer.buildPackage;
exports.applyPackageStream = exports.installPackageStream = packageStreamer.installPackage;
exports.checkPackageStream = packageStreamer.checkPackageStream;
exports.checkPackage = packageStreamer.checkPackage;
exports.getPackageMetadataFromStream = packageStreamer.getPackageMetadataFromStream;

const diffTool = require('./diffpatch');




/*
 * pkgConfig holds an array of pacakge configuration objects:
   {
     key:"package key",
     enableFilesystemSync:true,
     fs_path:"path of package files - absolute or relative to noonian base",
     include:{lookup table - classes explicitly included in this package},
     exclude:{lookup table - classes to exclude from this package}
   }
 */
var pkgConfig;
var packageKeyToId; //to look-up BOP id with package key
var packageKeyToConfig;


//utility to convert the include/exclude list of classes into the lookup table
const bcClassListToLookupTable = function(classList) {
  var ret = {};
  _.forEach(classList, item => {
    if(typeof item === 'string') {
      ret[item] = true;
    }
    else if(item && item.class_name) {
      ret[item.class_name] = item.condition || true;
    }
  });
  return ret;
};

const updatePackageConfig = function() {
    
    //Sync up w/ package meta if it belongs to an fs-synced package
    var THIS = this;
    _.forEach(pkgConfig, function(p) {      
        if(p.enableFilesystemSync && p.key === THIS.key) {
            fsPackageSyncer.writeMetaFile(p.fs_path, THIS);
        }
    });
    
    return db.BusinessObjectPackage.find({}).then(function(bopList) {
            
        var fsConfig = serverConf.packageFsConfig || {};
        
        packageKeyToId = {};//Build up BOP key->id map
        packageKeyToConfig = {}; //and one for the Config
        pkgConfig = [];
        
        _.forEach(bopList, function(bop) {
            packageKeyToId[bop.key] = bop._id;
            
            if(bop.enable_building || fsConfig[bop.key]) {
                var cfg = {key:bop.key, _id:bop._id};
                pkgConfig.push(cfg);
                packageKeyToConfig[bop.key] = cfg;
                
                var bConfig = bop.build_config || {};
                var myFsConfig = fsConfig[bop.key];
                
                var fsPath = (typeof myFsConfig === 'string') ? myFsConfig : (myFsConfig && myFsConfig.syncDir); 
                if(fsPath) {
                    cfg.enableFilesystemSync = true;
                    cfg.fs_path = (typeof fsPath === 'string') ? fsPath : 'server/data_pkg/'+bop.key;
                }
                if(bConfig.include) {                    
                    if(bConfig.include instanceof Array) {
                      cfg.include = bcClassListToLookupTable(bConfig.include);                    
                    }
                    else {
                      console.error('BAD BUILD CONFIG FOR PACKAGE: %s  (include not array)', bop.key);
                    }
                }
                if(bConfig.exclude) {
                  if(bConfig.exclude instanceof Array) {
                    cfg.exclude = bcClassListToLookupTable(bConfig.exclude);                    
                  }
                  else {
                    console.error('BAD BUILD CONFIG FOR PACKAGE: %s (exclude not array)', bop.key);
                  }
                }
            }
        }); //end forEach(bopList)
        console.log('CURRENT PACKAGE CONFIG: %j', pkgConfig);
    });
};


/**
 * Initialize the package-builder logic: data trigger, etc.
 **/
exports.init = function() {
    console.log('Initializing packaging service');
    
    var promiseChain = Q(true);
    
    //Load in fs-persisted packages as configured in serverConf.packageFsConfig
    _.forEach(serverConf.packageFsConfig, function(myFsConfig, pkgKey) {
        console.log('...loading %s from filesystem...', pkgKey);
        
        var fsPath = (typeof myFsConfig === 'string') ? myFsConfig : myFsConfig.syncDir;        
        promiseChain = promiseChain.then(fsPackageSyncer.packageFromFs.bind(null, fsPath));
    });
    
    //Build up aggregate packageConf by merging in configurations from BusinessObjectPackages
    promiseChain = promiseChain
    .then(updatePackageConfig)
    .then(function() {
        
        //Register UpdateLogger datatrigger
        DataTriggerService.registerDataTrigger(
            'sys.internal.update_logger', 
            null,               //any BO class
            'after',            //'after' change is persisted to DB
            true,               //on create
            true,               //on update
            true,               //on delete
            exports.updateLogger  //the handler
        );
        
        //Register DT to keep pkgConfig in sync w/ BusinessObjectPackage's in the db
        DataTriggerService.registerDataTrigger(
            'sys.internal.business_object_package', 
            'QLN_PHr_Tj6nzgzrHA4XdQ',   //BusinessObjectPackage
            'after',            //'after' change is persisted to DB
            true,               //on create
            true,               //on update
            true,               //on delete
            updatePackageConfig  //the handler
        );
        
        
        
    })
    ;

    return promiseChain;
}; //end init()



/**
 * When any update happens in the system, create an UpdateLog object, which tracks:
 *   timestamp, updated object, version updated, diff patch (apply to updated version to revert), 
 *   and package reference
 */
 var ignoreClasses = {
    BusinessObjectPackage:true,
    UpdateLog:true,
    PackageConflict:true
};

const functionsToStrings = function(obj) {
  let ret = {};
  _.forEach(Object.keys(obj), f => {
    if(typeof obj[f] === 'function') {
      ret[f] = ''+obj[f];
    }
    else {
      ret[f] = obj[f];
    }
  });
  
  return ret;
}

exports.updateLogger = function(isCreate, isUpdate, isDelete) {
    var myClass = this._bo_meta_data.class_name;
    
    if(ignoreClasses[myClass]) {
        return;
    }
    
    if(!db.UpdateLog) {
        return console.error('missing UpdateLog business object.  System upgrade required.');
    }
    
    var updateType = isCreate ? 'create' : (isUpdate ? 'update' : 'delete');
    
    //console.log('updateLogger: %s for %j', updateType, this);
    
    var updateLogObj = new db.UpdateLog({
       timestamp: new Date(),
       object_class: myClass,
       object_id: this._id,
       update_type:updateType,
       object_disp:this._disp
    });
    
    if(!isCreate) {        
        updateLogObj.updated_version = this._previous.__ver;
        
        if(serverConf.enableHistory) {            
            if(isDelete) {
                updateLogObj.revert_patch = this._previous;
            }
            else {  
                //its an update; store the diff
                //  want to be able to take it from current -> previous 
                // (diffTool configured to ignore properties starting w/ underscore)
                var current = this;
                var previous = this._previous;
                //TODO DOESNT WORK FOR OBJECTS W/ FUNCTION FIELDS!  NEED TO CONVERT TO STRING FIRST!!!
                var currToDiff = functionsToStrings(current.toPlainObject());
                var prevToDiff = functionsToStrings(previous);
                delete currToDiff._previous;
                updateLogObj.revert_patch = diffTool.diff(currToDiff, prevToDiff);
            }
        }
    }
    
    var targetPkg;
    
    if(serverConf.enablePackaging) {
        //console.log('processing packaging!');
        //Determine the package to which this updateLog is attached.
        var THIS = this;
        _.forEach(pkgConfig, function(p) {
            if(p.exclude && p.exclude[myClass]) {
              let cond = p.exclude[myClass];
              if(typeof cond === 'boolean') {
                return; //true boolean -> exclude unconditionally
              }
              if(THIS.satisfiesCondition(cond)) {
                return;  //condition passes -> exclude from pkg
              }
            }
                        
            if(p.include) {
              let cond = p.include[myClass];
              if(!cond) {
                return;  //either false or not in explicit 'include' list -> exclude from pkg
              }
              if(typeof cond === 'object') {
                if(!THIS.satisfiesCondition(cond)) {
                  return;  //condition doesn't pass -> exclude from pkg
                }
              }
            }
            //Use the first one on the list that matches
            targetPkg = targetPkg || p;
        });
        // console.log('targetPkg: %j', targetPkg);
        
        if(targetPkg) {
            //Set a special flag if a BO belonging to a different "external"
            // package is incorporated into another package
            updateLogObj.external_pkg = !!(this.__pkg && this.__pkg !== targetPkg.key);
            
            //Declare "ownership" of this BO if it hasn't already been declared
            this.__pkg = this.__pkg || targetPkg.key;
            
            //Link this update to the configured package
            updateLogObj.package = {_id:targetPkg._id};
            
            //Persist update to filesystem if configured to do so
            if(targetPkg.enableFilesystemSync) {
               fsPackageSyncer.removeObjectFromPackageDir(targetPkg.fs_path, this);
               if(!isDelete) {
                   fsPackageSyncer.writeObjectToPackageDir(targetPkg.fs_path, this);
               }
           }
        }
        else if(this.__pkg) {
            //pacakging is not explicitly configured for this change, 
            // but the BO has an "owner" package, so let's tie it to the UpdateLog
            var ownerPkgId = packageKeyToId[this.__pkg];
            if(ownerPkgId) {
                updateLogObj.package = {_id:ownerPkgId};
            }
            else {
                console.warn('Owning package %s missing from this system (owned by %s.%s', this.__pkg, myClass, this._id);
            }
        }
    }
    
    var retPromise = updateLogObj.save({skipTriggers:true});
    
    /*
     * We want to persist the UpdateLog object so that the package can be built
     * on an instance populated from the objects on the filesystem.
     * Objects belonging to the package are enumerated in the manifest, 
     * so we only need to keep track of creates and deletes
     * 
     */
    if(targetPkg && targetPkg.enableFilesystemSync) {  //we're syncing to the filesystem
        if(!isUpdate || serverConf.enableHistory) {
            // its either a create or delete OR we want to save all history        
            retPromise = retPromise.then(function(logObj) {
                fsPackageSyncer.writeObjectToPackageDir(targetPkg.fs_path, logObj);
            });
        }
    }
    
    return retPromise;
};




/**
 * Apply package attached to a BusinessObjectPackage
 */
exports.applyPackage = function(bopId) {
  var bopObj;
  return db.BusinessObjectPackage.findOne({_id:bopId})
    .then(function(bop) {
      bopObj = bop;

      if(!bop || !bop.package_file || !bop.package_file.attachment_id) {
        throw 'Invalid BusinessObjectPackage';
      }
      else {
        return GridFsService.getFile(bop.package_file.attachment_id)
      }
    })
    .then(function(gridfsFileObj) {
      console.log('Loading Data Package from %s', gridfsFileObj.metadata.filename);
      return packageStreamer.installPackage(gridfsFileObj.readstream, null, true).then(function(retBop) {
        bopObj = retBop;
      });
    })
    .then(db._svc.RefService.repair)
    .then(function() {
      return bopObj.key;
    });

};


/**
 * - searches local PKG_DIR for package w/ pkgName
 * - applies latest version it finds
 **/
var PKG_DIR = 'server/data_pkg';
exports.applyLocalPackage = function(pkgName) {

  // var deferred = Q.defer();

  var pkgFiles = fs.readdirSync(PKG_DIR);

  var fileRegex = new RegExp(pkgName+'\\.(\\d+)\\.(\\d+)\\.json');

  var foundFilename;
  var maj=-1, min=-1;

  _.forEach(pkgFiles, function(filename) {
    var match = fileRegex.exec(filename);
    if(match) {
      var testMaj = +match[1];
      var testMin = +match[2];
      if(testMaj > maj || (testMaj == maj && testMin > min) ) {
        foundFilename = filename;
        maj = testMaj;
        min = testMin;
      }
    }
  });
  console.log('Loading local package file %s (version %s.%s)', foundFilename, maj, min);

  var readstream = fs.createReadStream(PKG_DIR+'/'+foundFilename);

  return packageStreamer.installPackage(readstream);

};



/**
 * importObject
 * Import a plain json object (originating from a package or file) into db 
 * With special handling of BusinessObjectDef's and versioning.
 * 
 * used by both fs_sync and pkg_stream 
 * 
 * @param className
 * @param obj JSON object
 * @param pacakgeRef - reference to BusinessObjectPackage on who's behalf this object is being imported;
 *                     if not present, no version checking will occur
 */
exports.importObject = function(className, obj, packageRef) {
    var boId = obj._id;
    
    if(!db[className]) {
        //May happen if installing a package who's dependencies aren't installed
        if(!packageRef || ! db.PackageConflict) {                
            throw new Error('missing class '+className);
        }
        //Flag the problem via a PackageConflict
        var conflictObj = new db.PackageConflict({
            package:packageRef,
            conflict_type:'missing class',
            object_class:className,
            object_id:boId,
            package_version_id:obj.__ver,
            merged_object:obj
        });
        return conflictObj.save();
    }
    
    return db[className].findOne({_id:boId}).then(function(modelObj) {
        
        if(packageRef && modelObj && db.PackageConflict) {
            
            //Check validity of stepping from current version -> update version
            var updateVer = obj.__ver;
            
            var currentVer = new VersionId(modelObj.__ver);
            var pkgVer = new VersionId(updateVer);
            var versionRel = pkgVer.relationshipTo(currentVer);
            
            if(versionRel.same) {
                //If they're the same
                if(className === 'BusinessObjectDef') {
                    //Special case: always refresh BOD's w/ system datalayer
                    return db.installBusinessObjectDef(obj);
                }
                else {
                    return;
                }
            }
            
            if(!versionRel.descendant) {
                //update is not a decendent of currentVer, raise a flag
                var conflictObj = new db.PackageConflict({
                    package:packageRef,
                    object_class:className,
                    object_id:boId,
                    installed_version_id:modelObj.__ver,
                    package_version_id:updateVer
                });
                
                if(versionRel.cousin) {
                    conflictObj.conflict_type = 'divergent';
                    //incorporate all data needed to perform a merge
                    conflictObj.installed_object = modelObj.toPlainObject();
                    conflictObj.merged_object = obj;
                    //diff from installed -> package version
                    conflictObj.diff = diffTool.diff(conflictObj.installed_object, conflictObj.merged_object);
                } 
                else {
                    conflictObj.conflict_type = 'independent update';
                    //installed one is actually newer; diff serves to highlight the local changes made to the package version
                    conflictObj.diff = diffTool.diff(obj, modelObj.toPlainObject());
                }
                
                return conflictObj.save();
            }
        }
        
        if(className === 'BusinessObjectDef') {
            return db.installBusinessObjectDef(obj);
        }
                
        var updateVer = obj.__ver;
        delete obj.__ver;
        
        if(!modelObj) {
            modelObj = new db[className](obj);
        }
        else {
            _.assign(modelObj, obj);
        }			
        
        return modelObj.save({useVersionId:updateVer, skipTriggers:true}, null);
        
    });
	
};



/**
 * Exports a package's objects to filesystem, to begin filesystem sync and allow for 
 * collaboration/source control in git
 */
exports.packageToFs = function(bopId) {
    var bopObj;
  return db.BusinessObjectPackage.findOne({_id:bopId})
    .then(function(bop) {
      bopObj = bop;

      if(!bop) {
        throw 'Invalid BusinessObjectPackage';
      }
      else {
          var cfg = packageKeyToConfig[bop.key];
          if(!cfg || !cfg.fs_path) {
              throw 'Filesystem sync not configured for '+bop.key+'. Please set packageFsConfig in instance config.';
          }
          
          return fsPackageSyncer.packageObjectsToFs(bop, cfg.fs_path);
      }
    });
}

/**
 * Convenience function to drop the full package json file (attached to BOP) into data_pkg directory.
 **/
exports.packageFileExport = function(bopId) {
  var bopObj;
  return db.BusinessObjectPackage.findOne({_id:bopId})
    .then(function(bop) {
      bopObj = bop;

      if(!bop) {
        throw 'Invalid BusinessObjectPackage';
      }
      else if(singleFile && (!bop.package_file || !bop.package_file.attachment_id) ){
        throw 'Missing package_file';
      }
      else {
        return GridFsService.getFile(bop.package_file.attachment_id).then(function(gridfsFileObj) {
          console.log('Exporting package %s to data_pkg on filesystem', gridfsFileObj.metadata.filename);

          var outputFile = fs.createWriteStream(PKG_DIR+'/'+gridfsFileObj.metadata.filename);
          return gridfsFileObj.readstream.pipe(outputFile);

        });  
      }
    });
};


//Used by sys webservice pkg/runUpdate of sys <=0.69
// return an object with a compareTo 
const parseVersionString = exports.parseVersionString = function(verStr) {
  var properVersion =  new semver(semver.coerce(verStr));
  
  properVersion.compareTo = function(otherVersion) {
    if(typeof otherVersion === 'object' && !otherVersion.version) {
      //Old deprecated version object
      otherVersion = new parseVersionString((otherVersion.major||0)+'.'+(otherVersion.minor||0));
    }
    return semver.compare(this, otherVersion);
  }
  return properVersion;  
};

