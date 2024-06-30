import {asyncHandler} from '../utils/asyncHandler.js'
import {ApiError} from '../utils/ApiError.js'
import {User} from '../models/user.model.js'
import { uploadOnCludinary } from '../utils/cloudinary.js';
import { upload } from '../middlewares/multer.middleware.js';
import { ApiResponce } from '../utils/ApiResponce.js';
import fs from 'fs'
import jwt from 'jsonwebtoken';
import { subscribe } from 'diagnostics_channel';
import mongoose from 'mongoose';


const generateAccessAndRefreshTokens = async(userId) => {
    try {
        const user = await User.findById(userId);
        const accessToken = user.generateAccessToken();
        const refreshToken = user.generateRefreshToken();
        user.refreshToken = refreshToken;
        await user.save({ validateBeforeSave:false });
        return {accessToken,refreshToken};
    } catch (error) {
        throw new ApiError(500,"Something went wrong while generating refresh and access tokens");
    }
}

const registerUser = asyncHandler(async (req,res) =>{
    // get user details from frontend
    // validation - not empty
    // check if user already exists: username, email
    // check for images, check for avatar
    // upload them to cloudinary, avatar
    // create user object - create entry in db
    // remove password and refresh token field from responce
    // check for user creation
    // return res

    const {fullName,email,username,password} = req.body;
    // console.log("email",email);

    if (
        [fullName,email,username,password].some((field) => field?.trim() === "")
    ){
        throw new ApiError(400,'All fields are required');
    }

    const existedUser = await User.findOne({
        $or: [{username},{email}]
    })
    
    
    if(existedUser){
        throw new ApiError(409,'User with email or username already exists');
    }

    const avatarLocalPath = req.files?.avatar[0]?.path;
    // const coverImageLocalPath = req.files?.coverImage[0]?.path;
    let coverImageLocalPath;
    if(req.files && Array.isArray(req.files.coverImage) && req.files.coverImage.length > 0){
        coverImageLocalPath = req.files.coverImage[0].path;
    }
        
    if (!avatarLocalPath) {
        throw new ApiError(400,'Avatar file is required');
    }

    const avatar = await uploadOnCludinary(avatarLocalPath);
    const coverImage = await uploadOnCludinary(coverImageLocalPath);

    if(!avatar){
        throw new ApiError(400,'Avatar file is required');
    }

    const user = await User.create({
        fullName,
        avatar : avatar.url,
        coverImage : coverImage?.url || "",
        email,
        password,
        username : username.toLowerCase(),
    })

    const createdUser = await User.findById(user._id).select(
        "-password -refreshToken"
    );

    if(!createdUser){
        throw new ApiError(500,"Something went wrong while registering the user");
    }

    return res.status(201).json(
        new ApiResponce(200,createdUser,"User Registered Successfully")
    );
});


const loginUser = asyncHandler(async (req,res) => {
    // req body -> data
    // username or email
    // find the user
    // password check
    // access and refresh token
    // send cookie
    const {email,username,password} = req.body;
    if(!username && !email){
        throw new ApiError(400,"Username or password is required");
    }

    const user = await User.findOne({
        $or: [{username},{email}]
    })

    if(!user){
        throw new ApiError(404,"User doesnt exists");
    }

    const isPasswordValid = await user.isPasswordCorrext(password);
    if(!isPasswordValid){
        throw new ApiError(401,"Invalid user credentials");
    }

    const {accessToken,refreshToken} = await generateAccessAndRefreshTokens(user._id);

    const loggedInUser = await User.findById(user._id).select("-password -refreshToken");

    const options = {
        httpOnly :true,
        secure:true,
    }

    return res
    .status(200)
    .cookie("accessToken",accessToken,options)
    .cookie("refreshToken",refreshToken,options)
    .json(
        new ApiResponce(
            200,
            {
                user:loggedInUser,
                accessToken,
                refreshToken,
            },
            "User logged in succesfully",
        )
    );
});

const logoutUser = asyncHandler( async(req,res) =>{
    await User.findByIdAndUpdate(
        req.user._id,
        {
            $set:{
                refreshToken:undefined,
            }
        },
        {
            new:true,
        }
    )

    const options = {
        httpOnly :true,
        secure:true,
    }

    return res
    .status(200)
    .clearCookie("accessToken",options)
    .clearCookie("refreshToken",options)
    .json(new ApiResponce(200,{},"User logged out"));
});

const refreshAccessToken = asyncHandler( async (req,res) => {
    const incomingRefreshToken = req.cookies.refreshToken || req.body.refreshToken;

    if(!incomingRefreshToken){
        throw new ApiError(401,"unauthorised reqest");
    }

    try {
        const decodedToken = jwt.verify(
            incomingRefreshToken,
            process.env.REFRESH_TOKEN_SECRET
        );
    
        const user = await User.findById(decodedToken?._id);
    
        if(!user){
            throw new ApiError(401,"Invalid refresh token");
        }
    
        if(incomingRefreshToken !== user?.refreshToken){
            throw new ApiError(401,"Refresh token is expired or used");
        }
    
        const options = {
            httpOnly:true,
            secure:true,
        }
    
        const {accessToken,newRefreshToken} = await generateAccessAndRefreshTokens(user._id);
    
        return res
        .status(200)
        .cookie('accessToken',accessToken,options)
        .cookie('refreshToken',newRefreshToken,options)
        .json(
            new ApiResponce(
                200,
                {
                accessToken,refreshToken:newRefreshToken
                },
                "Access token refreshed",
            )
        );
    } catch (error) {
        throw new ApiError(401,error?.message || "Invalid refresh token");
    }
});

const changeCurrentPassword =  asyncHandler(async(req,res) => {
    const {oldPassword, newPassword} = req.body;
    
    const user = await User.findById(req.user?._id);

    const isPasswordCorrext = await user.isPasswordCorrext(oldPassword);

    if(!isPasswordCorrext){
        throw new ApiError(400,"Incorrect password");
    }

    user.password = newPassword;
    await user.save({validateBeforeSave});

    return res
    .status(200)
    .json(new ApiResponce(200,{},"Password changed succesfully"));
});

const getCurrentUser = asyncHandler(async(req,res) => {
    return res
    .status(200)
    .json(
        new ApiResponce(
            200,req.user,"current user fetched successfully"
        )
    );
});

const updateAccountDetails = asyncHandler(async(req,res) => {
    const {fullName,email} = req.body;

    if(!fullName || !email){
        throw new ApiError(400,"All fields are required");
    }

    const user = await User.findByIdAndUpdate(
        req.user?._id,
        {
            $set:{
                fullName,
                email,
            }
        },
        {new :true},
    ).select("-password")

    return res
    .status(200)
    .json(new ApiResponce(200,user,"Account details updated successfully"));
});

const updateUserAvatar = asyncHandler(async(req,res) => {
    const avatarLocalePath = req.file?.path;
    if(!avatarLocalePath){
        throw new ApiError(400,"Avatar file is missing");
    }
    const avatar = await uploadOnCludinary(avatarLocalePath);
    if(!avatar.url){
        throw new ApiError(400,"Error while uploading");
    }

    const user = await User.findByIdAndUpdate(
        req.user?._id,
        {
            $set:{
                avatar:avatar.url,
            }
        },
        {
            new:true
        }
    ).select("-password");

    return res
    .status(200)
    .json(new ApiResponce(200,user,"Avatar updated successfully"));
});

const updateUserCoverImage = asyncHandler(async(req,res) => {
    const coverImageLocalePath = req.file?.path;
    if(!coverImageLocalePath){
        throw new ApiError(400,"Cover Image file is missing");
    }
    const coverImage = await uploadOnCludinary(coverImageLocalePath);
    if(!coverImage.url){
        throw new ApiError(400,"Error while uploading");
    }

    const user = await User.findByIdAndUpdate(
        req.user?._id,
        {
            $set:{
                coverImage:coverImage.url,
            }
        },
        {
            new:true
        }
    ).select("-password");

    return res
    .status(200)
    .json(
        new ApiResponce(200,user,"Cover image updated successfully")
    );
});

const getUserChannelProfile = asyncHandler(async(req,res) => {
    const {username} = req.params;

    if(!username?.trim()){
        throw new ApiError(400,"Username is missing");
    }

    const channel = await User.aggregate([
        {
            $match: {
                username:username?.toLowerCase()
            },          
        },
        {
            $lookup: {
                from: "subscriptions",
                localField: "_id",
                foreignField: "channel",
                as: "subscribers"
            }
        },
        {
            $lookup: {
                from: "subscriptions",
                localField: "_id",
                foreignField: "subscriber",
                as: "subscribedTo",
            },
        },
        {
            $addFields: {
                subscribersCount :{
                    $size: "$subscribers"
                },
                channelsSubscribedToCount: {
                    $size: "$subscribedTo"
                },
                isSubscribed: {
                    $cond: {
                        if: {$in: [req.user?._id,"$subscribers.subscriber"]},
                        then: true,
                        else: false,
                    }
                }
            }
        },
        {
            $project: {
                fullName:1,
                username: 1,
                email: 1,
                avatar: 1,
                coverImage: 1,
                subscribersCount: 1,
                channelsSubscribedToCount: 1,
                isSubscribed: 1,
            }
        },
    ]);
    if(!channel?.length){
        throw new ApiError(404,"Channel doesn't exists");
    }
    return res
    .status(200)
    .json(new ApiResponce(200,channel[0],"User channel fetched succesfully"));
});

const getWatchHistory = asyncHandler(async(req,res) => {
    const user = await User.aggregate(
        [
            {
                $match: {
                    _id: new mongoose.Types.ObjectId(req.user._id),
                }
            },
            {
                $lookup: {
                    from: "videos",
                    localField: "watchHistory",
                    foreignField: "_id",
                    as: "watchHistory",
                    pipeline: [
                        {
                            $lookup: {
                                from: "users",
                                localField: "owner",
                                foreignField: "_id",
                                as: "owner",
                                pipeline: [
                                    {
                                        $project:{
                                            fullName: 1,
                                            username: 1,
                                            avatar: 1,
                                        }
                                    }
                                ]
                            }
                        },
                        {
                            $addFields:{
                                owner:{
                                    $first: "$owner",
                                },
                            },
                        },
                    ],
                },
            },
        ],
    );
    return res
    .status(200)
    .json(
        new ApiResponce(
            200,
            user[0].watchHistory,
            "Watch history fetched successfully",
        )
    );
});



export {
    registerUser,
    loginUser,
    logoutUser,
    refreshAccessToken,
    changeCurrentPassword,
    getCurrentUser,
    updateAccountDetails,
    updateUserAvatar,
    updateUserCoverImage,
    getUserChannelProfile,
    getWatchHistory,
}